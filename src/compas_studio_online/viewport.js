
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
        this.camera.up.set(0, 0, 1); // Z-up convention
        this.camera.position.set(-30, -30, 30); // Standard ISO view: X=Right, Y=Left, Z=Up
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
        // Lighter grid: Center=0x888888, Grid=0xcccccc
        const grid = new THREE.GridHelper(50, 50, 0x888888, 0xcccccc);
        grid.rotation.x = Math.PI / 2; // Rotate to lie on XY plane (Z-up)
        this.scene.add(grid);
        this.scene.add(new THREE.AxesHelper(5));
    }

    _addControls() {
        this.target = new THREE.Vector3(0, 0, 0);
        
        // Spherical coordinates for Orbit (Z-up)
        // r, phi (polar: angle from Z), theta (azimuthal: angle from X on XY plane)
        let radius = this.camera.position.distanceTo(this.target);
        const relPos = new THREE.Vector3().subVectors(this.camera.position, this.target);
        
        let theta = Math.atan2(relPos.y, relPos.x); // XY Plane angle
        let phi = Math.acos(relPos.z / radius);     // Angle from Z axis

        // Interaction State
        let isDragging = false;
        let prevPos = { x: 0, y: 0 };
        let mouseButton = -1; // 0: Left, 2: Right

        const updateCamera = () => {
            // Convert spherical to Z-Up Cartesian
            // z = r cos(phi)
            // x = r sin(phi) cos(theta)
            // y = r sin(phi) sin(theta)
            
            // Constrain phi to avoid flipping (0 to PI)
            phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));

            const x = radius * Math.sin(phi) * Math.cos(theta);
            const y = radius * Math.sin(phi) * Math.sin(theta);
            const z = radius * Math.cos(phi);

            this.camera.position.set(x, y, z).add(this.target);
            this.camera.lookAt(this.target);
        };

        const handlePan = (deltaX, deltaY) => {
            // Pan logic: Move target and camera in camera-local X/Y plane
            // Speed proportional to distance
            const speed = radius * 0.002; // Adjust sensitivity
            
            // Camera Up and Right vectors
            const forward = new THREE.Vector3().subVectors(this.target, this.camera.position).normalize();
            const up = this.camera.up.clone(); // (0,0,1)
            
            // Note: Standard 'right' is forward x up
            const right = new THREE.Vector3().crossVectors(forward, up).normalize();
            
            // Local Up (perpendicular to view direction and right vector)
            const localUp = new THREE.Vector3().crossVectors(right, forward).normalize();
            
            // Inverse deltaX for expected feel
            const panVec = new THREE.Vector3()
                .addScaledVector(right, -deltaX * speed)
                .addScaledVector(localUp, deltaY * speed);
                
            this.target.add(panVec);
            updateCamera();
        };

        const handleRotate = (deltaX, deltaY) => {
            theta -= deltaX * 0.005; 
            phi -= deltaY * 0.005; 
            updateCamera();
        };

        this.container.addEventListener('mousedown', (e) => {
            isDragging = true;
            mouseButton = e.button;
            prevPos = { x: e.clientX, y: e.clientY };
            e.preventDefault(); // Stop text selection
        });

        // Prevent context menu to allow Right-Click Drag
        this.container.addEventListener('contextmenu', (e) => e.preventDefault());

        this.container.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const delta = { x: e.clientX - prevPos.x, y: e.clientY - prevPos.y };
            prevPos = { x: e.clientX, y: e.clientY };

            if (mouseButton === 0) {
                // Left Click: Rotate (Invert X delta for natural feel if needed, otherwise positive)
                handleRotate(delta.x, delta.y);
            } else if (mouseButton === 2) {
                // Right Click (or 2-finger drag/click): Pan
                handlePan(delta.x, delta.y);
            }
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
            mouseButton = -1;
        });

        this.container.addEventListener('click', (e) => {
            // Only select if not dragged (or small drag)
            // For now simple pass through, but ideally check drift
            this.handleSelection(e);
        });
        
        this.container.addEventListener('wheel', (e) => {
           e.preventDefault();
           
           // If Shift pressed, Pan on both axes
           if (e.shiftKey) {
               handlePan(e.deltaX, e.deltaY);
               return;
           }

           // Zoom (deltaY)
           const zoomSpeed = 0.001 * radius;
           radius += e.deltaY * zoomSpeed;
           radius = Math.max(0.1, radius); // Min distance
           
           updateCamera();
        }, { passive: false });
        
        // Initial setup
        updateCamera();
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

        // Matte finish, light grey, 90% opaque
        const color = 0xcccccc; 
        const material = new THREE.MeshLambertMaterial({ 
            color: color, 
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.9,
            polygonOffset: true, 
            polygonOffsetFactor: 1, 
            polygonOffsetUnits: 1 
        });
        
        const mesh = new THREE.Mesh(geometry, material);

        // Thin dark grey outlines (ridges/edges)
        // Using EdgesGeometry with threshold to catch sharp edges but ignore triangulation diagonals on flat quads
        const edgesGeo = new THREE.EdgesGeometry(geometry, 15); 
        const edgesMat = new THREE.LineBasicMaterial({ color: 0x333333, opacity: 0.5, transparent: true });
        const edges = new THREE.LineSegments(edgesGeo, edgesMat);
        mesh.add(edges);
        
        mesh.userData = { variableName: name, originalColor: color };
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
        obj.material.color.setHex(0xe0e0e0); // Selection: Light Grey
        
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
