// WebGL-rendered ants using a glTF model.
//
// A second canvas overlays the existing 2D terrain canvas. This
// renderer owns just the ant layer — terrain stays 2D so we don't
// pay WebGL costs for 288 000 unchanging dirt cells per frame.
//
// Each live ant gets a transformed instance of the loaded model.
// At 10 ants × ~17 k tris that's ~170 k tris per frame: trivial
// for any modern GPU.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Colony } from '../sim/colony';

export class AntMeshRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  /** The loaded ant template; null until ant.glb finishes loading. */
  private template: THREE.Object3D | null = null;
  /** Per-ant cloned instances, parallel to colony.id. Grows on demand. */
  private readonly pool: THREE.Object3D[] = [];
  /** Bounding-box max axis of the loaded model in model units. */
  private templateLengthUnits = 1;
  /** Yaw offset added to per-instance heading (radians). */
  modelYawOffset = -Math.PI / 2;

  constructor(canvas: HTMLCanvasElement, worldWidth: number, worldHeight: number) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    // Orthographic camera mapped 1:1 to world cells. Top = 0,
    // bottom = worldHeight gives the same y-grows-down convention
    // as the rest of the sim and the terrain canvas.
    this.camera = new THREE.OrthographicCamera(
      0, worldWidth, 0, worldHeight, -1000, 1000,
    );
    this.camera.position.z = 100;
    this.camera.lookAt(worldWidth / 2, worldHeight / 2, 0);

    // Lighting: warm sun + soft fill so the chitin reads.
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xfff4d6, 1.1);
    sun.position.set(0.3, -1, 0.6);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xc8d9ff, 0.4);
    fill.position.set(-0.4, -0.6, 0.3);
    this.scene.add(fill);
  }

  /** Begin loading the model. Returns when ready. */
  async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    // EXT_meshopt_compression decoder — required because we ran the
    // model through `gltf-transform optimize` which compresses
    // geometry buffers with meshopt.
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);

    // The Fab-converted model is +Z up (long axis along X, depth
    // along Y, height along Z). Our ortho camera looks down +Z, so
    // without correction we'd see top-down instead of side-view.
    // Wrap the loaded scene in a parent that rotates -π/2 around X:
    //   model +Z (height) → world −Y (screen up)
    //   model +Y (depth)  → world +Z (toward camera)
    //   model +X (length) → world +X (unchanged) — heading 0 = right
    // The wrapper also centers the geometry so per-instance
    // .position is the ant's centre, not its bounding-box corner.
    const inner = gltf.scene;
    const box = new THREE.Box3().setFromObject(inner);
    const centre = new THREE.Vector3();
    box.getCenter(centre);
    inner.position.sub(centre);

    const oriented = new THREE.Group();
    oriented.add(inner);
    oriented.rotation.x = -Math.PI / 2;
    this.template = oriented;

    // Measure the model's longest axis AFTER rotation so the
    // per-ant scale factor is in the right frame.
    const orientedBox = new THREE.Box3().setFromObject(this.template);
    const size = new THREE.Vector3();
    orientedBox.getSize(size);
    this.templateLengthUnits = Math.max(size.x, size.y, size.z);
    this.modelYawOffset = 0;
  }

  /** Add radians to the per-instance yaw to correct nose-direction. */
  setModelYawOffset(rad: number): void {
    this.modelYawOffset = rad;
  }

  /**
   * Resize the canvas backing store and re-aim the camera at the
   * world centre. Called whenever the terrain canvas resizes so
   * the two layers stay aligned.
   */
  resize(canvasWidth: number, canvasHeight: number, worldRect: { dx: number; dy: number; dw: number; dh: number }): void {
    if (this.canvas.width !== canvasWidth || this.canvas.height !== canvasHeight) {
      this.renderer.setSize(canvasWidth, canvasHeight, false);
    }
    // Use a viewport that matches the world rect on the terrain
    // canvas so the ants render exactly over the dirt.
    this.renderer.setViewport(worldRect.dx, canvasHeight - worldRect.dy - worldRect.dh, worldRect.dw, worldRect.dh);
    this.renderer.setScissor(worldRect.dx, canvasHeight - worldRect.dy - worldRect.dh, worldRect.dw, worldRect.dh);
    this.renderer.setScissorTest(true);
  }

  /**
   * Update transforms for all live ants and render. `alpha` is the
   * tick-interpolation factor (matching the 2D renderer's contract).
   */
  render(colony: Colony, alpha: number): void {
    if (!this.template) return;

    // Grow / shrink the pool to match colony size.
    while (this.pool.length < colony.count) {
      const inst = this.template.clone(true);
      this.pool.push(inst);
      this.scene.add(inst);
    }
    while (this.pool.length > colony.count) {
      const removed = this.pool.pop()!;
      this.scene.remove(removed);
    }

    for (let i = 0; i < colony.count; i++) {
      const inst = this.pool[i]!;
      const px = colony.prevX[i]!;
      const py = colony.prevY[i]!;
      const x = colony.posX[i]! * alpha + px * (1 - alpha);
      const y = colony.posY[i]! * alpha + py * (1 - alpha);
      inst.position.set(x, y, 0);
      // Scale to per-ant body length.
      const bodyCells = colony.bodyLengthCells[i]!;
      const s = bodyCells / this.templateLengthUnits;
      inst.scale.set(s, s, s);
      // Heading interpolated between prev and current so 30 Hz sim
      // doesn't snap the body angle every tick — important for
      // detail-rich 3D models. Wrap-aware: take the shorter rotation
      // arc.
      const h0 = colony.prevHeading[i]!;
      const h1 = colony.heading[i]!;
      let dh = h1 - h0;
      if (dh > Math.PI) dh -= 2 * Math.PI;
      else if (dh < -Math.PI) dh += 2 * Math.PI;
      const headingLerp = h0 + dh * alpha;
      inst.rotation.set(0, 0, headingLerp + this.modelYawOffset);
    }

    this.renderer.render(this.scene, this.camera);
  }
}
