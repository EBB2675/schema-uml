import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GraphView from '../src/GraphView';
import type { UmlGraphState } from '../src/types/uml';

// Records every node id that gets measured via boundingBox({ includeLabels }).
let boundingBoxCalls: string[] = [];

// Minimal fake Cytoscape core: a real event bus plus the handful of methods
// GraphView touches. Layout never runs, so the test drives `layoutstop`
// explicitly. `boundingBox` pushes the node id so the regression assertions can
// see exactly which nodes were re-measured and when.
function makeFakeCy(nodeIds: string[]) {
  const listeners: Record<string, Array<(evt: unknown) => void>> = {};

  const makeNode = (id: string) => {
    let pos = { x: 0, y: 0 };
    return {
      id: () => id,
      data: (key?: string) => {
        const d: Record<string, string> = { id, label: id, rawName: id, module: '' };
        return key ? d[key] : d;
      },
      position: (next?: { x: number; y: number }) => {
        if (next) {
          pos = { ...next };
          return undefined;
        }
        return pos;
      },
      empty: () => false,
      select: () => {},
      addClass: () => {},
      boundingBox: () => {
        boundingBoxCalls.push(id);
        return { x1: pos.x, y1: pos.y, x2: pos.x + 120, y2: pos.y + 60, w: 120, h: 60 };
      },
    };
  };

  let nodes = nodeIds.map(makeNode);

  const coll = (arr: ReturnType<typeof makeNode>[]) => ({
    forEach: (f: (n: ReturnType<typeof makeNode>) => void) => arr.forEach(f),
    filter: (f: (n: ReturnType<typeof makeNode>) => boolean) => coll(arr.filter(f)),
    first: () => arr[0] ?? { empty: () => true },
    empty: () => arr.length === 0,
    length: arr.length,
  });

  const cy = {
    __pan: { x: 0, y: 0 },
    __zoom: 1,
    destroy: () => {},
    resize: () => {},
    fit: () => {},
    png: () => null,
    animate: () => {},
    minZoom: () => 0.2,
    maxZoom: () => 3.5,
    pan: () => cy.__pan,
    zoom: () => cy.__zoom,
    nodes: () => coll(nodes),
    $: (sel: string) => coll(sel === 'edge' ? [] : nodes),
    getElementById: (id: string) => nodes.find((n) => n.id() === id) ?? { empty: () => true },
    ready: (cb: () => void) => cb(),
    on(ev: string, a: unknown, b?: unknown) {
      const cb = (b ?? a) as (evt: unknown) => void;
      ev.split(/\s+/).forEach((name) => ((listeners[name] ||= []).push(cb)));
    },
    off(ev: string, a: unknown, b?: unknown) {
      const cb = (b ?? a) as (evt: unknown) => void;
      ev.split(/\s+/).forEach((name) => {
        listeners[name] = (listeners[name] || []).filter((x) => x !== cb);
      });
    },
    one(ev: string, cb: (evt: unknown) => void) {
      const wrap = (evt: unknown) => {
        cy.off(ev, wrap);
        cb(evt);
      };
      cy.on(ev, wrap);
    },
    emit(ev: string, evt?: unknown) {
      ev.split(/\s+/).forEach((name) => {
        (listeners[name] || []).slice().forEach((cb) => cb(evt ?? { target: cy }));
      });
    },
    __setNodes(ids: string[]) {
      nodes = ids.map(makeNode);
    },
  };

  return cy;
}

let fakeCy: ReturnType<typeof makeFakeCy>;

// Controllable requestAnimationFrame: GraphView coalesces viewport syncs into
// one frame, so the tests queue the callbacks and flush them explicitly.
let rafQueue: FrameRequestCallback[] = [];
const flushRaf = () => {
  const queued = rafQueue;
  rafQueue = [];
  queued.forEach((cb) => cb(0));
};

vi.mock('cytoscape', () => ({ __esModule: true, default: vi.fn(() => fakeCy) }));
vi.mock('cytoscape-elk', () => ({ __esModule: true, default: vi.fn() }));
vi.mock('elkjs/lib/elk.bundled.js', () => ({ __esModule: true, default: vi.fn() }));

const CLASS_A = 'pkg.custom_schema.Alpha';
const CLASS_B = 'pkg.custom_schema.Beta';

const umlState: UmlGraphState = {
  package: 'pkg.custom_schema',
  root: '',
  classes: [
    { id: CLASS_A, name: 'Alpha', module: 'pkg.custom_schema', quantities: [] },
    { id: CLASS_B, name: 'Beta', module: 'pkg.custom_schema', quantities: [] },
  ],
  edges: [{ source: CLASS_A, target: CLASS_B, type: 'inherits' }],
};

function renderGraph() {
  return render(
    <GraphView
      nodes={[
        { id: CLASS_A, kind: 'section', label: 'Alpha' },
        { id: CLASS_B, kind: 'section', label: 'Beta' },
      ]}
      edges={[]}
      umlState={umlState}
      editableMode
      onCreateQuantity={vi.fn().mockResolvedValue(undefined)}
      onCreateClass={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

describe('GraphView overlay geometry vs. viewport synchronization', () => {
  beforeEach(() => {
    boundingBoxCalls = [];
    rafQueue = [];
    fakeCy = makeFakeCy([CLASS_A, CLASS_B]);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafQueue.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('measures initial geometry and renders overlay cards', () => {
    renderGraph();
    expect(new Set(boundingBoxCalls)).toEqual(new Set([CLASS_A, CLASS_B]));
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('does not re-measure nodes on pan, zoom or render, but keeps the overlay transform aligned', () => {
    const { container } = renderGraph();
    const wrapper = container.querySelector('div[style*="translate"]') as HTMLElement;
    expect(wrapper).toBeTruthy();

    boundingBoxCalls = [];

    fakeCy.__pan = { x: 30, y: 40 };
    act(() => {
      fakeCy.emit('pan');
      flushRaf();
    });
    expect(boundingBoxCalls).toEqual([]);
    expect(wrapper.style.transform).toContain('translate(30px, 40px)');

    fakeCy.__zoom = 2;
    act(() => {
      fakeCy.emit('zoom');
      flushRaf();
    });
    expect(boundingBoxCalls).toEqual([]);
    expect(wrapper.style.transform).toContain('scale(2)');

    act(() => {
      fakeCy.emit('render');
      flushRaf();
    });
    expect(boundingBoxCalls).toEqual([]);
  });

  it('coalesces multiple pan/zoom events in a frame into a single viewport sync', () => {
    const { container } = renderGraph();
    const wrapper = container.querySelector('div[style*="translate"]') as HTMLElement;

    rafQueue = [];
    fakeCy.__pan = { x: 12, y: 8 };
    fakeCy.__zoom = 1.5;

    act(() => {
      fakeCy.emit('pan');
      fakeCy.emit('zoom');
      fakeCy.emit('pan');
    });

    // One scheduled callback for three events, and no transform update yet.
    expect(rafQueue).toHaveLength(1);
    expect(wrapper.style.transform).not.toContain('translate(12px, 8px)');

    act(() => flushRaf());
    expect(wrapper.style.transform).toContain('translate(12px, 8px)');
    expect(wrapper.style.transform).toContain('scale(1.5)');
  });

  it('re-measures all nodes when the layout finishes', () => {
    renderGraph();
    boundingBoxCalls = [];

    act(() => fakeCy.emit('layoutstop'));

    expect(new Set(boundingBoxCalls)).toEqual(new Set([CLASS_A, CLASS_B]));
  });

  it('rebuilds the card-box map without crashing when node ids change but the count does not', () => {
    renderGraph();
    boundingBoxCalls = [];

    // Same node count, entirely different ids (e.g. switching packages).
    fakeCy.__setNodes(['pkg.other.Gamma', 'pkg.other.Delta']);

    expect(() => act(() => fakeCy.emit('layoutstop'))).not.toThrow();
    expect(new Set(boundingBoxCalls)).toEqual(
      new Set(['pkg.other.Gamma', 'pkg.other.Delta'])
    );
  });

  it('measures only the dragged node while dragging, not every node', () => {
    renderGraph();
    boundingBoxCalls = [];

    const card = screen.getByText('Alpha').closest('.uml-card') as HTMLElement;
    expect(card).toBeTruthy();

    fireEvent.mouseDown(card, { button: 0, clientX: 0, clientY: 0 });
    act(() => {
      fireEvent.mouseMove(window, { clientX: 25, clientY: 15 });
      fireEvent.mouseMove(window, { clientX: 60, clientY: 45 });
    });
    fireEvent.mouseUp(window);

    expect(boundingBoxCalls.length).toBeGreaterThan(0);
    expect(new Set(boundingBoxCalls)).toEqual(new Set([CLASS_A]));
  });

  it('keeps connector lines following the dragged card (edges are driven by cardBoxes)', () => {
    const { container } = renderGraph();
    const line = () => container.querySelector('.uml-edit-edges line') as SVGLineElement;
    expect(line()).toBeTruthy();
    const before = line().getAttribute('x1');

    const card = screen.getByText('Alpha').closest('.uml-card') as HTMLElement;
    fireEvent.mouseDown(card, { button: 0, clientX: 0, clientY: 0 });
    act(() => {
      fireEvent.mouseMove(window, { clientX: 140, clientY: 90 });
    });
    fireEvent.mouseUp(window);

    expect(line().getAttribute('x1')).not.toEqual(before);
  });
});
