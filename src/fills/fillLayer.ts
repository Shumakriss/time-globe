// Custom WebGL layer drawing territory fills. Growth and decline are animated entirely on the GPU
// from a single `u_year` uniform, so motion costs nothing per frame and never waits on MapLibre's
// tile workers. Borders and labels remain ordinary MapLibre layers.
import type maplibregl from 'maplibre-gl';
import type { CustomLayerInterface, CustomRenderMethodInput } from 'maplibre-gl';
import { VERTEX_FLOATS } from './mesh';
import type { BuildResult, FocusRequest } from './meshWorker';
import { prefetchYears, WINDOW_COUNT, windowOf, windowRange } from './windows';

const FILL_OPACITY = 0.6;
const FRONT_SOFTNESS = 0.35; // width of the growth front, as a fraction of the ramp
const MAX_CACHED_WINDOWS = 4;

const VERTEX_SHADER = (prelude: string, define: string) => `#version 300 es
precision highp float;
${prelude}
${define}
in vec2 a_pos;
in float a_d;
in float a_kind;
in vec2 a_ramp;
in vec2 a_span;
in vec3 a_color;
in float a_rid;
uniform float u_year;
uniform float u_hover;
out float v_d;
out float v_kind;
out float v_t;
out vec3 v_color;
out float v_hover;
void main() {
  if (u_year < a_span.x || u_year >= a_span.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside clip space: culled, no fragment cost
    return;
  }
  v_d = a_d;
  v_kind = a_kind;
  v_t = clamp((u_year - a_ramp.x) / max(0.001, a_ramp.y - a_ramp.x), 0.0, 1.0);
  v_color = a_color;
  v_hover = abs(a_rid - u_hover) < 0.5 ? 1.0 : 0.0;
  gl_Position = projectTile(a_pos);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in float v_d;
in float v_kind;
in float v_t;
in vec3 v_color;
in float v_hover;
uniform float u_opacity;
uniform float u_softness;
out vec4 fragColor;
void main() {
  float a = 1.0;
  float glow = 0.0;
  if (v_kind > 0.5) {
    // A front sweeps across the piece as t goes 0 -> 1; fully settled at t = 0 and t = 1.
    // Gained: appears nearest the old border first. Yield: vanishes exactly where a neighbour's gain
    // appears (same front). Lost: vanishes farthest from the new border first.
    bool lost = v_kind < 1.5;
    bool gained = v_kind > 1.5 && v_kind < 2.5;
    float at = lost ? 1.0 - v_d : v_d;
    float r = smoothstep(0.0, 1.0, clamp((v_t * (1.0 + u_softness) - at) / u_softness, 0.0, 1.0));
    a = gained ? r : 1.0 - r;
    if (gained) glow = 4.0 * a * (1.0 - a); // brighten the advancing edge slightly
  }
  vec3 color = mix(v_color, vec3(1.0), 0.18 * glow + 0.2 * v_hover);
  float alpha = a * (u_opacity + 0.15 * v_hover);
  fragColor = vec4(color * alpha, alpha);
}`;

interface GpuMesh {
  window: number;
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  count: number;
}

export interface FillLayer extends CustomLayerInterface {
  setYear(displayYear: number): void;
  setHover(recordId: number | null): void;
}

export function createFillLayer(map: maplibregl.Map, onFirstMesh: () => void): FillLayer {
  const worker = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' });
  let gl: WebGL2RenderingContext | null = null;
  const programs = new Map<string, { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> }>();
  const meshes = new Map<number, GpuMesh>(); // window -> mesh, in LRU order
  let lastDrawn: GpuMesh | undefined;
  let year = 1;
  let direction = 1; // +1 forward in time, -1 backward
  let hover = -1;
  let gotFirst = false;
  let lastFocus = '';

  /** Ask the worker for the windows we'll need, most urgent first; it drops anything stale. */
  const focus = () => {
    const y = Math.floor(year);
    const w = windowOf(y);
    // Distance (years) to the window's start and end boundaries.
    const toStart = y - (w === 0 ? -Infinity : windowRange(w)[0]);
    const toEnd = windowRange(w)[1] - y;
    const p = prefetchYears(w);
    const ahead = w + direction;
    const behind = w - direction;
    const nearAhead = (direction > 0 ? toEnd : toStart) < 2 * p;
    const nearBehind = (direction > 0 ? toStart : toEnd) < p;
    const wanted = [w, ahead, ...(nearAhead ? [ahead + direction] : []), ...(nearBehind ? [behind] : [])]
      .filter((x) => x >= 0 && x < WINDOW_COUNT && !meshes.has(x));
    const key = wanted.join(',');
    if (key === lastFocus) return;
    lastFocus = key;
    worker.postMessage({ type: 'focus', windows: wanted } satisfies FocusRequest);
  };

  worker.onmessage = (e: MessageEvent<BuildResult>) => {
    const { window: w, vertices, indices, ms } = e.data;
    lastFocus = '';
    if (!gl) return;
    if (import.meta.env.DEV) console.debug(`[fills] window ${w}: ${vertices.length / VERTEX_FLOATS} verts in ${ms}ms`);
    meshes.set(w, upload(gl, w, vertices, indices));
    // Evict the oldest meshes, never the one on screen.
    for (const [key, m] of meshes) {
      if (meshes.size <= MAX_CACHED_WINDOWS) break;
      if (m === lastDrawn || key === w) continue;
      release(gl, m);
      meshes.delete(key);
    }
    if (!gotFirst) {
      gotFirst = true;
      onFirstMesh();
    }
    map.triggerRepaint();
  };

  function upload(g: WebGL2RenderingContext, w: number, vertices: Float32Array, indices: Uint32Array): GpuMesh {
    const vao = g.createVertexArray()!;
    g.bindVertexArray(vao);
    const vbo = g.createBuffer()!;
    g.bindBuffer(g.ARRAY_BUFFER, vbo);
    g.bufferData(g.ARRAY_BUFFER, vertices, g.STATIC_DRAW);
    const ibo = g.createBuffer()!;
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, ibo);
    g.bufferData(g.ELEMENT_ARRAY_BUFFER, indices, g.STATIC_DRAW);
    // Attribute locations are bound explicitly at link time (see compile()).
    const stride = VERTEX_FLOATS * 4;
    const attrs: [number, number, number][] = [
      [0, 2, 0], // a_pos
      [1, 1, 2], // a_d
      [2, 1, 3], // a_kind
      [3, 2, 4], // a_ramp
      [4, 2, 6], // a_span
      [5, 3, 8], // a_color
      [6, 1, 11], // a_rid
    ];
    for (const [loc, size, offset] of attrs) {
      g.enableVertexAttribArray(loc);
      g.vertexAttribPointer(loc, size, g.FLOAT, false, stride, offset * 4);
    }
    g.bindVertexArray(null);
    return { window: w, vao, vbo, ibo, count: indices.length };
  }

  function release(g: WebGL2RenderingContext, m: GpuMesh) {
    g.deleteVertexArray(m.vao);
    g.deleteBuffer(m.vbo);
    g.deleteBuffer(m.ibo);
  }

  function compile(g: WebGL2RenderingContext, shaderData: CustomRenderMethodInput['shaderData']) {
    const cached = programs.get(shaderData.variantName);
    if (cached) return cached;
    const shader = (type: number, src: string) => {
      const s = g.createShader(type)!;
      g.shaderSource(s, src);
      g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const program = g.createProgram()!;
    g.attachShader(program, shader(g.VERTEX_SHADER, VERTEX_SHADER(shaderData.vertexShaderPrelude, shaderData.define)));
    g.attachShader(program, shader(g.FRAGMENT_SHADER, FRAGMENT_SHADER));
    ['a_pos', 'a_d', 'a_kind', 'a_ramp', 'a_span', 'a_color', 'a_rid'].forEach((n, i) => g.bindAttribLocation(program, i, n));
    g.linkProgram(program);
    if (!g.getProgramParameter(program, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(program) ?? 'link error');
    const names = [
      'u_year', 'u_hover', 'u_opacity', 'u_softness',
      'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane',
      'u_projection_transition', 'u_projection_fallback_matrix',
    ];
    const entry = { program, uniforms: Object.fromEntries(names.map((n) => [n, g.getUniformLocation(program, n)])) };
    programs.set(shaderData.variantName, entry);
    return entry;
  }

  /**
   * The best available mesh for the current year: its own window, else a neighbour that covers it,
   * else whatever was last on screen (long-lived polities stay filled while a new window builds).
   */
  function currentMesh(): GpuMesh | undefined {
    const y = Math.floor(year);
    const own = meshes.get(windowOf(y));
    if (own) return own;
    for (const m of meshes.values()) {
      const [a, b] = windowRange(m.window);
      if (y >= a && y <= b) return m;
    }
    return lastDrawn;
  }

  return {
    id: 'territory-fills',
    type: 'custom',
    renderingMode: '2d',

    onAdd(_map, context) {
      gl = context as WebGL2RenderingContext;
      focus();
    },

    onRemove() {
      worker.terminate();
      if (gl) for (const m of meshes.values()) release(gl, m);
      meshes.clear();
    },

    render(g, options) {
      const g2 = g as WebGL2RenderingContext;
      const mesh = currentMesh();
      if (!mesh) return;
      lastDrawn = mesh;
      const { program, uniforms: u } = compile(g2, options.shaderData);
      const pd = options.defaultProjectionData;
      g2.useProgram(program);
      g2.uniform1f(u.u_year, year);
      g2.uniform1f(u.u_hover, hover);
      g2.uniform1f(u.u_opacity, FILL_OPACITY);
      g2.uniform1f(u.u_softness, FRONT_SOFTNESS);
      g2.uniformMatrix4fv(u.u_projection_matrix, false, pd.mainMatrix as Float32Array);
      g2.uniform4f(u.u_projection_tile_mercator_coords, ...pd.tileMercatorCoords);
      g2.uniform4f(u.u_projection_clipping_plane, ...pd.clippingPlane);
      g2.uniform1f(u.u_projection_transition, pd.projectionTransition);
      g2.uniformMatrix4fv(u.u_projection_fallback_matrix, false, pd.fallbackMatrix as Float32Array);
      g2.disable(g2.DEPTH_TEST);
      g2.disable(g2.CULL_FACE);
      g2.disable(g2.STENCIL_TEST);
      g2.enable(g2.BLEND);
      g2.blendFunc(g2.ONE, g2.ONE_MINUS_SRC_ALPHA); // premultiplied alpha
      g2.bindVertexArray(mesh.vao);
      g2.drawElements(g2.TRIANGLES, mesh.count, g2.UNSIGNED_INT, 0);
      g2.bindVertexArray(null);
    },

    setYear(displayYear: number) {
      if (displayYear !== year) direction = displayYear > year ? 1 : -1;
      year = displayYear;
      focus();
      map.triggerRepaint();
    },

    setHover(recordId: number | null) {
      hover = recordId ?? -1;
      map.triggerRepaint();
    },
  };
}
