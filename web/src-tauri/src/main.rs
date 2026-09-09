#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env, fs,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

const APP_LABEL: &str = "main";

type SharedChild = Arc<Mutex<Option<Child>>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopMode {
    // The only production desktop target today.
    Light,
    // Reserved for a future heavier desktop profile.
    Dev,
}

impl DesktopMode {
    fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "light" => Ok(Self::Light),
            "dev" => Ok(Self::Dev),
            other => Err(format!(
                "Unsupported SCHEMA_STUDIO_DESKTOP_MODE={other:?}. Supported modes: light"
            )),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ModeDescriptor {
    mode: DesktopMode,
    window_title: &'static str,
    sidecar_basename: &'static str,
    health_path: &'static str,
}

impl ModeDescriptor {
    /// Translate a user-facing mode name into the small contract the launcher needs.
    fn for_mode(mode: DesktopMode) -> Result<Self, String> {
        match mode {
            DesktopMode::Light => Ok(Self {
                mode,
                window_title: "Schema Studio Light",
                sidecar_basename: "schema-studio-backend",
                health_path: "/health",
            }),
            DesktopMode::Dev => Err(
                "Desktop launcher mode extension is prepared, but only Light Mode is implemented right now."
                    .to_string(),
            ),
        }
    }

    fn python_command(self) -> Vec<String> {
        match self.mode {
            DesktopMode::Light => vec!["-m".to_string(), "api.light_mode.cli".to_string()],
            DesktopMode::Dev => Vec::new(),
        }
    }

    fn sidecar_filename(self) -> String {
        let triple = env::var("TAURI_ENV_TARGET_TRIPLE")
            .or_else(|_| env::var("TARGET"))
            .unwrap_or_else(|_| env!("SCHEMA_STUDIO_BUILD_TARGET").to_string());
        if cfg!(target_os = "windows") {
            return format!("{}-{triple}.exe", self.sidecar_basename);
        }
        format!("{}-{triple}", self.sidecar_basename)
    }

    fn packaged_backend_candidates(self, repo_root: &Path) -> Vec<PathBuf> {
        let runtime_sidecar_name = if cfg!(target_os = "windows") {
            format!("{}.exe", self.sidecar_basename)
        } else {
            self.sidecar_basename.to_string()
        };
        let sidecar_names = [self.sidecar_filename(), runtime_sidecar_name];
        let mut candidates = Vec::new();

        for sidecar_name in &sidecar_names {
            candidates.push(
                repo_root
                    .join("web")
                    .join("src-tauri")
                    .join("binaries")
                    .join(sidecar_name),
            );
        }

        if let Ok(current_exe) = env::current_exe() {
            if let Some(exe_dir) = current_exe.parent() {
                for sidecar_name in &sidecar_names {
                    candidates.push(exe_dir.join(sidecar_name));
                    candidates.push(exe_dir.join("resources").join(sidecar_name));
                    candidates.push(exe_dir.join("Resources").join(sidecar_name));
                    if let Some(contents_dir) = exe_dir.parent() {
                        candidates.push(contents_dir.join("Resources").join(sidecar_name));
                    }
                }
            }
        }

        candidates
    }

    fn health_url(self, host: &str, port: u16) -> String {
        format!("http://{host}:{port}{}", self.health_path)
    }
}

#[derive(Clone, Debug)]
struct LauncherConfig {
    mode: ModeDescriptor,
    host: String,
    port: u16,
    backend_override: Option<String>,
    python: String,
    startup_timeout: Duration,
    reuse_backend: bool,
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("src-tauri should live under web/")
        .to_path_buf()
}

/// Load a simple repo-root `.env` file for local desktop development.
///
/// This is intentionally lightweight: it only fills missing environment
/// variables and leaves any already-exported values untouched.
fn load_repo_env(repo_root: &Path) {
    let env_path = repo_root.join(".env");
    let Ok(contents) = fs::read_to_string(env_path) else {
        return;
    };

    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || env::var_os(key).is_some() {
            continue;
        }

        let mut value = value.trim().to_string();
        let quoted = (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''));
        if quoted && value.len() >= 2 {
            value = value[1..value.len() - 1].to_string();
        }

        unsafe {
            env::set_var(key, value);
        }
    }
}

fn env_flag(name: &str, default: bool) -> bool {
    env::var(name)
        .ok()
        .map(|raw| {
            !matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(default)
}

fn env_u16(name: &str, default: u16) -> Result<u16, String> {
    match env::var(name) {
        Ok(raw) => raw
            .trim()
            .parse::<u16>()
            .map_err(|err| format!("Invalid {name}={raw:?}: {err}")),
        Err(_) => Ok(default),
    }
}

fn env_u64(name: &str, default: u64) -> Result<u64, String> {
    match env::var(name) {
        Ok(raw) => raw
            .trim()
            .parse::<u64>()
            .map_err(|err| format!("Invalid {name}={raw:?}: {err}")),
        Err(_) => Ok(default),
    }
}

fn default_python_candidates(repo_root: &Path) -> Vec<PathBuf> {
    vec![
        repo_root.join(".venv").join("Scripts").join("python.exe"),
        repo_root.join(".venv").join("bin").join("python"),
    ]
}

fn preferred_python(repo_root: &Path) -> String {
    if let Ok(raw) = env::var("SCHEMA_STUDIO_DESKTOP_PYTHON") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    for candidate in default_python_candidates(repo_root) {
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }

    if cfg!(target_os = "windows") {
        return "python.exe".to_string();
    }

    "python".to_string()
}

impl LauncherConfig {
    fn from_env(repo_root: &Path) -> Result<Self, String> {
        let raw_mode = DesktopMode::parse(
            &env::var("SCHEMA_STUDIO_DESKTOP_MODE").unwrap_or_else(|_| "light".to_string()),
        )?;
        let mode = ModeDescriptor::for_mode(raw_mode)?;
        let host =
            env::var("SCHEMA_STUDIO_DESKTOP_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = env_u16("SCHEMA_STUDIO_DESKTOP_PORT", 5179)?;
        let backend_override = env::var("SCHEMA_STUDIO_DESKTOP_BACKEND")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let startup_timeout = Duration::from_secs(env_u64(
            "SCHEMA_STUDIO_DESKTOP_STARTUP_TIMEOUT_SECONDS",
            30,
        )?);
        let reuse_backend = env_flag("SCHEMA_STUDIO_DESKTOP_REUSE_BACKEND", false);

        Ok(Self {
            mode,
            host,
            port,
            backend_override,
            python: preferred_python(repo_root),
            startup_timeout,
            reuse_backend,
        })
    }

    fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    fn health_url(&self) -> String {
        self.mode.health_url(&self.host, self.port)
    }

    fn socket_addr(&self) -> Result<SocketAddr, String> {
        format!("{}:{}", self.host, self.port)
            .parse()
            .map_err(|err| {
                format!(
                    "Invalid desktop backend address {}:{}: {err}",
                    self.host, self.port
                )
            })
    }
}

enum BackendLaunch {
    Packaged(PathBuf),
    PythonModule(String),
}

/// Resolve whether this run should use a bundled sidecar or a Python fallback.
fn resolve_backend_launch(config: &LauncherConfig, repo_root: &Path) -> BackendLaunch {
    if let Some(path) = config.backend_override.as_ref() {
        return BackendLaunch::Packaged(PathBuf::from(path));
    }

    for candidate in config.mode.packaged_backend_candidates(repo_root) {
        if candidate.exists() {
            return BackendLaunch::Packaged(candidate);
        }
    }

    BackendLaunch::PythonModule(config.python.clone())
}

fn launch_workdir(repo_root: &Path, launch: &BackendLaunch) -> PathBuf {
    match launch {
        BackendLaunch::Packaged(path) => path
            .parent()
            .map(Path::to_path_buf)
            .or_else(|| env::current_dir().ok())
            .unwrap_or_else(|| repo_root.to_path_buf()),
        BackendLaunch::PythonModule(_) => repo_root.to_path_buf(),
    }
}

fn configure_backend_env(cmd: &mut Command, config: &LauncherConfig, launch: &BackendLaunch) {
    if matches!(launch, BackendLaunch::Packaged(_)) {
        // The frozen backend resolves its own bundled frontend path.
        cmd.env_remove("SCHEMA_STUDIO_DIST_DIR");
    }

    cmd.env("SCHEMA_STUDIO_HOST", &config.host)
        .env("SCHEMA_STUDIO_PORT", config.port.to_string())
        .env("SCHEMA_STUDIO_PARENT_PID", std::process::id().to_string())
        .env(
            "SCHEMA_STUDIO_OPEN_BROWSER",
            env::var("SCHEMA_STUDIO_OPEN_BROWSER").unwrap_or_else(|_| "0".to_string()),
        );

    for key in [
        "SCHEMA_STUDIO_HOME",
        "SCHEMA_STUDIO_DEFAULT_PACKAGE",
        "SCHEMA_STUDIO_DEFAULT_NAMESPACE",
        "SCHEMA_STUDIO_DIST_DIR",
        "SCHEMA_STUDIO_AUTO_BOOTSTRAP_SCHEMA",
        "SCHEMA_STUDIO_SEND_ENDPOINT",
        "UVICORN_LOG_LEVEL",
    ] {
        if let Ok(value) = env::var(key) {
            cmd.env(key, value);
        }
    }
}

fn spawn_backend(config: &LauncherConfig) -> Result<Child, String> {
    let repo_root = repo_root();
    let launch = resolve_backend_launch(config, &repo_root);
    let launch_cwd = launch_workdir(&repo_root, &launch);
    let mut cmd = match &launch {
        BackendLaunch::Packaged(path) => Command::new(path),
        BackendLaunch::PythonModule(python) => {
            let mut cmd = Command::new(python);
            for arg in config.mode.python_command() {
                cmd.arg(arg);
            }
            cmd
        }
    };

    cmd.current_dir(&launch_cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    configure_backend_env(&mut cmd, config, &launch);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Put the backend in its own process group so shutdown can terminate any
        // helper children it spawned, such as schema update subprocesses.
        cmd.process_group(0);
    }

    cmd.spawn().map_err(|err| match &launch {
        BackendLaunch::Packaged(path) => {
            format!("failed to launch packaged backend {:?}: {err}", path)
        }
        BackendLaunch::PythonModule(python) => {
            format!(
                "failed to launch backend with interpreter {:?}: {err}",
                python
            )
        }
    })
}

/// Check whether the configured desktop backend is already answering requests.
fn backend_is_healthy(config: &LauncherConfig) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    matches!(
        client.get(config.health_url()).send(),
        Ok(response) if response.status().is_success()
    )
}

fn port_is_in_use(config: &LauncherConfig) -> Result<bool, String> {
    let addr = config.socket_addr()?;
    Ok(TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok())
}

fn ensure_backend_state_before_spawn(config: &LauncherConfig) -> Result<bool, String> {
    if backend_is_healthy(config) {
        if config.reuse_backend {
            return Ok(true);
        }
        return Err(format!(
            "A backend is already running at {}. Stop it first, or set SCHEMA_STUDIO_DESKTOP_REUSE_BACKEND=1 to attach to it during development.",
            config.base_url()
        ));
    }

    if port_is_in_use(config)? {
        return Err(format!(
            "Port {} is already in use, but no healthy Schema Studio backend answered at {}. Free the port or change SCHEMA_STUDIO_DESKTOP_PORT.",
            config.port,
            config.health_url()
        ));
    }

    Ok(false)
}

fn wait_for_backend(config: &LauncherConfig, child_state: &SharedChild) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .map_err(|err| format!("failed to build health-check client: {err}"))?;
    let start = Instant::now();
    while start.elapsed() < config.startup_timeout {
        match client.get(config.health_url()).send() {
            Ok(response) if response.status().is_success() => return Ok(()),
            _ => {
                let mut guard = child_state.lock().expect("backend child mutex poisoned");
                if let Some(child) = guard.as_mut() {
                    if let Ok(Some(status)) = child.try_wait() {
                        return Err(format!(
                            "Light Mode backend exited before becoming ready (status: {status})"
                        ));
                    }
                }
                drop(guard);
                thread::sleep(Duration::from_millis(250));
            }
        }
    }
    Err(format!(
        "Light Mode backend did not become ready at {} within {} seconds",
        config.health_url(),
        config.startup_timeout.as_secs()
    ))
}

fn stop_backend(child_state: &SharedChild) {
    let mut guard = child_state.lock().expect("backend child mutex poisoned");
    if let Some(mut child) = guard.take() {
        #[cfg(target_os = "windows")]
        {
            // Kill the full process tree so helper children do not linger.
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }

        #[cfg(unix)]
        {
            let group_id = format!("-{}", child.id());
            let _ = Command::new("kill")
                .args(["-TERM", &group_id])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();

            let wait_deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < wait_deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(Duration::from_millis(100));
            }

            let _ = Command::new("kill")
                .args(["-KILL", &group_id])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }

        let _ = child.kill();
        let _ = child.wait();
    }
}

fn create_window(app: &tauri::AppHandle, config: &LauncherConfig) -> Result<(), tauri::Error> {
    let window = WebviewWindowBuilder::new(
        app,
        APP_LABEL,
        WebviewUrl::External(config.base_url().parse().expect("valid backend URL")),
    )
    .title(config.mode.window_title)
    .inner_size(1440.0, 960.0)
    .min_inner_size(1100.0, 720.0)
    .resizable(true)
    .build()?;

    #[cfg(debug_assertions)]
    window.open_devtools();

    #[cfg(not(debug_assertions))]
    let _ = &window;

    Ok(())
}

fn main() {
    let repo_root = repo_root();
    load_repo_env(&repo_root);
    let config = LauncherConfig::from_env(&repo_root)
        .unwrap_or_else(|err| panic!("invalid desktop launcher configuration: {err}"));

    let backend_child: SharedChild = Arc::new(Mutex::new(None));
    let managed_child = Arc::clone(&backend_child);
    let config_for_setup = config.clone();
    let config_for_window = config.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(move |app| {
            let reusing_existing = ensure_backend_state_before_spawn(&config_for_setup)?;
            if !reusing_existing {
                let child = spawn_backend(&config_for_setup)?;
                {
                    let mut guard = managed_child.lock().expect("backend child mutex poisoned");
                    *guard = Some(child);
                }
                if let Err(err) = wait_for_backend(&config_for_setup, &managed_child) {
                    stop_backend(&managed_child);
                    return Err(err.into());
                }
            }

            create_window(app.handle(), &config_for_window).map_err(Into::into)
        })
        .build(tauri::generate_context!())
        .expect("error while building Schema Studio desktop shell")
        .run(move |_app_handle, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                stop_backend(&backend_child);
            }
        });
}
