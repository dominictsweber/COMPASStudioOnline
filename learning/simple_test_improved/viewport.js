
class ViewportManager {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) throw new Error("Viewport container not found");

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        
        // State
        this.fileObjects = new Map(); // filename -> Array<THREE.Mesh>
        this.visibleFiles = new Set();
        this.selectedObject = null;

        // Callbacks
        this.onObjectSelected = null; // (name) => void

        this.init();
    }

    init() {
        // Scene Setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf0f0f0); // Soft grey background

        this.camera = new THREE.PerspectiveCamera(75, this.container.clientWidth / this.container.clientHeight, 0.1, 1000);
        this.camera.position.set(20, 20, 20);
        this.camera.lookAt(0, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.shadowMap.enabled = true;
        this.container.appendChild(this.renderer.domElement);

        // Environment
        this._addLights();
        this._addHelpers();
        this._addControls();

        // Loop
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);

        window.addEventListener('resize', () => this.onWindowResize());
    }

    _addLights() {
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(10, 10, 5);
        this.scene.add(dirLight);
    }

    _addHelpers() {
        this.scene.add(new THREE.GridHelper(50, 50, 0x444444, 0x222222));
        this.scene.add(new THREE.AxesHelper(5));
    }

    _addControls() {
        // Simple orbital controls
        let isDragging = false;
        let prevPos = { x: 0, y: 0 };

        this.container.addEventListener('mousedown', (e) => {
            isDragging = true;
            prevPos = { x: e.clientX, y: e.clientY };
        });

        this.container.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const delta = { x: e.clientX - prevPos.x, y: e.clientY - prevPos.y };
            
            // Rotate Camera
            const radius = this.camera.position.length();
            let theta = Math.atan2(this.camera.position.x, this.camera.position.z);
            let phi = Math.acos(this.camera.position.y / radius);

            theta -= delta.x * 0.005;
            phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi - delta.y * 0.005));

            this.camera.position.x = radius * Math.sin(phi) * Math.sin(theta);
            this.camera.position.y = radius * Math.cos(phi);
            this.camera.position.z = radius * Math.sin(phi) * Math.cos(theta);
            this.camera.lookAt(0, 0, 0);

            prevPos = { x: e.clientX, y: e.clientY };
        });

        window.addEventListener('mouseup', () => isDragging = false);
        this.container.addEventListener('click', (e) => this.handleSelection(e));
        
        this.container.addEventListener('wheel', (e) => {
           e.preventDefault();
           const zoom = 0.05 * this.camera.position.length() * Math.sign(e.deltaY);
           this.camera.position.add(this.camera.position.clone().normalize().multiplyScalar(zoom));
        });
    }

    // --- API ---

    setFileVisibility(filename, isVisible) {
        if (isVisible) this.visibleFiles.add(filename);
        else this.visibleFiles.delete(filename);
        this.refreshVisibility();
    }

    updateFileGeometry(filename, geometryData) {
        // Clear Old
        const oldMeshes = this.fileObjects.get(filename) || [];
        oldMeshes.forEach(m => {
            this.scene.remove(m);
            if (m.geometry) m.geometry.dispose();
            if (m.material) m.material.dispose();
        });

        // Add New
        const newMeshes = [];
        geometryData.forEach(item => {
            if (item.type === 'Mesh') {
                const mesh = this.createMesh(item.data, item.name);
                if (mesh) {
                    mesh.userData.filename = filename;
                    mesh.userData.isGlobal = item.isGlobal;
                    this.scene.add(mesh);
                    newMeshes.push(mesh);
                }
            }
        });

        this.fileObjects.set(filename, newMeshes);
        this.refreshVisibility();
    }

    refreshVisibility() {
        this.fileObjects.forEach((meshes, fname) => {
            const isVisible = this.visibleFiles.has(fname);
            meshes.forEach(m => {
                m.visible = isVisible || !!m.userData.isGlobal;
            });
        });
    }

    createMesh(data, name) {
        if (!data.vertices || !data.faces) return null;

        const geometry = new THREE.BufferGeometry();
        const vertices = new Float32Array(data.vertices.flat());
        const indices = [];

        data.faces.forEach(f => {
            if (f.length === 3) indices.push(f[0], f[1], f[2]);
            else if (f.length === 4) indices.push(f[0], f[1], f[2], f[0], f[2], f[3]);
        });

        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        if (indices.length) geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const material = new THREE.MeshPhongMaterial({ color: 0x0088ff, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geometry, material);
        
        mesh.userData = { variableName: name, originalColor: 0x0088ff };
        return mesh;
    }

    // Export geometry associated with a file to OBJ format
    exportToOBJ(filename) {
        if (!this.fileObjects.has(filename)) return null;

        const meshes = this.fileObjects.get(filename);
        if (!meshes || meshes.length === 0) return null;

        let output = "# Exported from Simple Test (Improved) Web Viewer\n";
        let vertexOffset = 1;

        meshes.forEach((mesh, index) => {
            const name = mesh.userData.variableName || `mesh_${index}`;
            output += `o ${name}\n`;
            
            const positions = mesh.geometry.attributes.position.array;
            const indices = mesh.geometry.index ? mesh.geometry.index.array : null;

            // Vertices
            for (let i = 0; i < positions.length; i += 3) {
                output += `v ${positions[i]} ${positions[i+1]} ${positions[i+2]}\n`;
            }

            // Faces
            if (indices) {
                for (let i = 0; i < indices.length; i += 3) {
                    const v1 = indices[i] + vertexOffset;
                    const v2 = indices[i+1] + vertexOffset;
                    const v3 = indices[i+2] + vertexOffset;
                    output += `f ${v1} ${v2} ${v3}\n`;
                }
            } else {
                 // If no index buffer (unlikely with our createMesh), just dump triangles 0,1,2...
                 const vertexCount = positions.length / 3;
                 for (let i = 0; i < vertexCount; i += 3) {
                    const v1 = i + vertexOffset;
                    const v2 = i + 1 + vertexOffset;
                    const v3 = i + 2 + vertexOffset;
                    output += `f ${v1} ${v2} ${v3}\n`; 
                 }
            }

            vertexOffset += positions.length / 3;
        });

        return output;
    }

    handleSelection(e) {
        const rect = this.container.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        
        // Collect all visible meshes
        const allMeshes = [];
        this.scene.traverse(o => {
            if (o.isMesh && o.visible && o.userData.variableName) allMeshes.push(o);
        });

        const intersects = this.raycaster.intersectObjects(allMeshes);
        if (intersects.length > 0) {
            const hit = intersects[0].object;
            this.selectObject(hit);
        } else {
            this.deselect();
        }
    }

    selectObject(obj) {
        this.deselect();
        this.selectedObject = obj;
        obj.material.color.setHex(0xFF0000);
        
        if (this.onObjectSelected) {
            this.onObjectSelected(obj.userData.variableName);
        }
    }

    deselect() {
        if (this.selectedObject) {
            this.selectedObject.material.color.setHex(this.selectedObject.userData.originalColor);
            this.selectedObject = null;
        }
    }

    animate() {
        requestAnimationFrame(this.animate);
        this.renderer.render(this.scene, this.camera);
    }

    onWindowResize() {
        this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }
}
