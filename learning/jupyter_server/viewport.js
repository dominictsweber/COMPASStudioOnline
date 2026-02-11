console.log('Viewport loaded');
console.log('THREE is defined:', typeof THREE !== 'undefined');

let scene, camera, renderer, objects = [];

function initViewport() {
    const container = document.getElementById('viewport');
    
    // Scene setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x222222);
    
    // Camera
    camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(5, 5, 5);
    camera.lookAt(0, 0, 0);
    
    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);
    
    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 10, 5);
    directionalLight.castShadow = true;
    scene.add(directionalLight);
    
    // Grid
    const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
    scene.add(gridHelper);
    
    // Axes
    const axesHelper = new THREE.AxesHelper(5);
    scene.add(axesHelper);
    
    // Orbit controls (basic mouse)
    addMouseControls();
    
    // Animation loop
    animate();
    
    // Handle window resize
    window.addEventListener('resize', onWindowResize);
}

function addMouseControls() {
    let isDragging = false, previousMousePosition = { x: 0, y: 0 };
    const container = document.getElementById('viewport');
    
    container.addEventListener('mousedown', (e) => {
        isDragging = true;
        previousMousePosition = { x: e.clientX, y: e.clientY };
    });
    
    container.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        const deltaX = e.clientX - previousMousePosition.x;
        const deltaY = e.clientY - previousMousePosition.y;
        
        // Rotate camera around scene
        const radius = camera.position.length();
        const theta = Math.atan2(camera.position.x, camera.position.z);
        const phi = Math.acos(camera.position.y / radius);
        
        const newTheta = theta - deltaX * 0.005;
        const newPhi = Math.max(0.1, Math.min(Math.PI - 0.1, phi + deltaY * 0.005));
        
        camera.position.x = radius * Math.sin(newPhi) * Math.sin(newTheta);
        camera.position.y = radius * Math.cos(newPhi);
        camera.position.z = radius * Math.sin(newPhi) * Math.cos(newTheta);
        camera.lookAt(0, 0, 0);
        
        previousMousePosition = { x: e.clientX, y: e.clientY };
    });
    
    container.addEventListener('mouseup', () => { isDragging = false; });
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomSpeed = 0.1;
        const direction = camera.position.clone().normalize();
        const currentDistance = camera.position.length();
        const newDistance = Math.max(1, Math.min(100, currentDistance + (e.deltaY > 0 ? zoomSpeed : -zoomSpeed)));
        camera.position.copy(direction.multiplyScalar(newDistance));
    });
}

function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}

function onWindowResize() {
    const container = document.getElementById('viewport');
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

function clearScene() {
    objects.forEach(obj => {
        scene.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
    });
    objects = [];
}

function addGeometry(geomData) {
    if (!geomData) return;
    
    if (Array.isArray(geomData)) {
        geomData.forEach(g => addGeometry(g));
        return;
    }
    
    try {
        // Determine geometry type from 'type' field or object structure
        const type = geomData.type || Object.keys(geomData)[0];
        
        let obj;
        switch (type) {
            case 'Box':
                obj = createBox(geomData);
                break;
            case 'Sphere':
                obj = createSphere(geomData);
                break;
            case 'Cylinder':
                obj = createCylinder(geomData);
                break;
            case 'Mesh':
                obj = createMesh(geomData);
                break;
            case 'Point':
            case 'Vector':
                obj = createPoint(geomData);
                break;
            default:
                // Fallback: try to render as mesh if it has vertices/faces
                if (geomData.vertices) {
                    obj = createMesh(geomData);
                }
        }
        
        if (obj) {
            scene.add(obj);
            objects.push(obj);
        }
    } catch (err) {
        console.error('Error rendering geometry:', err, geomData);
    }
}

function createBox(data) {
    const xmax = data.xmax || 1, ymax = data.ymax || 1, zmax = data.zmax || 1;
    const xmin = data.xmin || 0, ymin = data.ymin || 0, zmin = data.zmin || 0;
    const w = xmax - xmin, h = ymax - ymin, d = zmax - zmin;
    const geometry = new THREE.BoxGeometry(w, h, d);
    const material = new THREE.MeshPhongMaterial({ color: 0x0088ff, shininess: 100 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(xmin + w / 2, ymin + h / 2, zmin + d / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

function createSphere(data) {
    const radius = data.radius || 1;
    const cx = data.center ? data.center[0] : 0;
    const cy = data.center ? data.center[1] : 0;
    const cz = data.center ? data.center[2] : 0;
    const geometry = new THREE.SphereGeometry(radius, 32, 32);
    const material = new THREE.MeshPhongMaterial({ color: 0xff6600, shininess: 100 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(cx, cy, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

function createCylinder(data) {
    const radius = data.radius || 1;
    const height = data.height || 2;
    const cx = data.center ? data.center[0] : 0;
    const cy = data.center ? data.center[1] : 0;
    const cz = data.center ? data.center[2] : 0;
    const geometry = new THREE.CylinderGeometry(radius, radius, height, 32);
    const material = new THREE.MeshPhongMaterial({ color: 0x00ff00, shininess: 100 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(cx, cy + height / 2, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

function createMesh(data) {
    if (!data.vertices || !data.faces) return null;
    
    const geometry = new THREE.BufferGeometry();
    const vertices = new Float32Array(data.vertices.flat ? data.vertices.flat() : data.vertices);
    const faces = new Uint32Array(data.faces.flat ? data.faces.flat() : data.faces);
    
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(faces, 1));
    geometry.computeVertexNormals();
    
    const material = new THREE.MeshPhongMaterial({ color: 0xcccccc, shininess: 100 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

function createPoint(data) {
    const x = data.x || data[0] || 0;
    const y = data.y || data[1] || 0;
    const z = data.z || data[2] || 0;
    const geometry = new THREE.SphereGeometry(0.1, 8, 8);
    const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    return mesh;
}

// // Wire up to runCode in app.js
// const originalRunCode = window.runCode;
// window.runCode = async function() {
//     const code = editor.getValue();
//     const outputDiv = document.getElementById('output');
    
//     outputDiv.textContent = 'Running...';
//     clearScene();
    
//     try {
//         const response = await fetch('/render', {
//             method: 'POST',
//             headers: { 'Content-Type': 'application/json' },
//             body: JSON.stringify({ code: code })
//         });
        
//         const result = await response.json();
        
//         if (result.success) {
//             outputDiv.textContent = result.output || '(No output)';
//             if (result.geometry) {
//                 result.geometry.forEach(geom => addGeometry(geom));
//             }
//         } else {
//             outputDiv.textContent = 'ERROR:\n' + result.error;
//         }
//     } catch (error) {
//         outputDiv.textContent = 'Connection failed: ' + error.message;
//     }
// };



// // Initialize when DOM is ready
// window.addEventListener('DOMContentLoaded', initViewport);

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initViewport);
} else {
    initViewport();
}