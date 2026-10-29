import * as THREE from '/vendor/three.module.js';

export function mountSpatialView(container, spec) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#f5f2eb');
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.domElement.setAttribute('role', 'img'); renderer.domElement.setAttribute('aria-label', `${spec.title}. Use rotation and zoom controls; exact coordinates are in the data table.`);
  const group = new THREE.Group(), bounds = new THREE.Box3();
  for (const p of spec.data) bounds.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
  const center = bounds.getCenter(new THREE.Vector3()), size = Math.max(...bounds.getSize(new THREE.Vector3()).toArray(), 1e-10);
  const positions = new Float32Array(spec.data.flatMap(p => [p.x, p.y, p.z]).map((n, i) => (n - center.toArray()[i % 3]) / size * 2));
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#193b32', size: 0.04 })); group.add(points);
  let mesh;
  if (spec.triangles?.length) {
    const meshGeometry = geometry.clone(); meshGeometry.setIndex(spec.triangles.flat()); meshGeometry.computeVertexNormals();
    mesh = new THREE.Mesh(meshGeometry, new THREE.MeshNormalMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.7 })); group.add(mesh);
  }
  const axes = new THREE.AxesHelper(1.5); group.add(axes); scene.add(group); camera.position.z = 4;
  const controls = document.createElement('div'); controls.className = 'visual-controls';
  let disposed = false;
  function render() { if (!disposed) renderer.render(scene, camera); }
  const inputs = [];
  for (const [label, axis, min, max, initial] of [['Rotate X', 'x', -180, 180, 0], ['Rotate Y', 'y', -180, 180, 0], ['Zoom', 'zoom', 2, 10, 4]]) {
    const wrapper = document.createElement('label'); wrapper.textContent = label;
    const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = axis === 'zoom' ? 0.1 : 1; input.value = initial;
    input.oninput = () => { if (axis === 'zoom') camera.position.z = Number(input.value); else group.rotation[axis] = Number(input.value) * Math.PI / 180; render(); };
    inputs.push([input, initial]); wrapper.append(input); controls.append(wrapper);
  }
  const reset = document.createElement('button'); reset.textContent = 'Reset view'; reset.type = 'button'; reset.onclick = () => { for (const [input, initial] of inputs) { input.value = initial; input.oninput(); } }; controls.append(reset);
  container.append(controls, renderer.domElement);
  const resize = () => { const width = Math.max(240, container.clientWidth), height = Math.min(480, width * 0.7); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); render(); };
  const observer = new ResizeObserver(resize); observer.observe(container); resize();
  return { canvas: renderer.domElement, dispose() { disposed = true; observer.disconnect(); geometry.dispose(); points.material.dispose(); mesh?.geometry.dispose(); mesh?.material.dispose(); axes.geometry.dispose(); axes.material.dispose(); renderer.dispose(); renderer.forceContextLoss(); } };
}
