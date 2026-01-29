from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from compas.geometry import Box, Sphere, Point, Frame, Circle, Cylinder
from compas.datastructures import Mesh
import json
import sys
from io import StringIO
import contextlib
import ast
import uvicorn
import os
import shutil
from pathlib import Path



# this is the dynmaic code part for now

# Store the execution context state
execution_context = {
    'scene_objects': [],
    'user_variables': {}
}

# List of COMPAS geometry types to auto-detect
COMPAS_GEOMETRY_TYPES = {
    Box, Sphere, Point, Frame, Circle, Cylinder, Mesh
}

def is_compas_geometry(obj):
    """Check if object is COMPAS geometry"""
    if obj is None:
        return False
    return any(isinstance(obj, geom_type) for geom_type in COMPAS_GEOMETRY_TYPES)

def extract_last_assignment(code: str):
    """Extract the last variable assignment from code"""
    try:
        tree = ast.parse(code)
        
        # Find the last assignment
        last_assignment = None
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                last_assignment = node
        
        if last_assignment and hasattr(last_assignment, 'targets'):
            # Get the variable name from the assignment
            if last_assignment.targets and hasattr(last_assignment.targets[0], 'id'):
                var_name = last_assignment.targets[0].id
                return var_name
    except:
        pass
    return None


app = FastAPI()

# Allow frontend to access backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)



@app.post("/api/execute")
async def execute_python_code(command: dict):
    """Execute arbitrary Python code in a controlled environment"""
    try:
        code = command.get("code", "").strip()
        
        # debugging:
        print(f"\n🔵 NEW REQUEST: {code}")
        print(f"🔵 COMPAS_GEOMETRY_TYPES: {[t.__name__ for t in COMPAS_GEOMETRY_TYPES]}")

        if not code:
            return {"success": False, "message": "Empty code"}
        
        # Capture stdout/stderr
        stdout = StringIO()
        stderr = StringIO()
        
        # Create a safe execution environment
        safe_globals = {
            '__builtins__': {
                'print': print,
                'len': len,
                'range': range,
                'list': list,
                'dict': dict,
                'str': str,
                'int': int,
                'float': float,
                'bool': bool,
            },
            # COMPAS geometry
            'Box': Box,
            'Sphere': Sphere,
            'Point': Point,
            'Frame': Frame,
            'Circle': Circle,
            'Cylinder': Cylinder,
            'Mesh': Mesh,
            
            # Scene management
            'scene_objects': execution_context['scene_objects'],
            
            # User variables persist between executions
            **execution_context['user_variables']
        }
        
        result = None
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                # Try to eval first (for single expressions)
                result = eval(code, safe_globals)
                print("yup we're evaluating")
            except:
                # If eval fails, exec instead
                exec(code, safe_globals)
                print("yup we're executing")
                print(f"🔵 safe_globals after exec: {list(safe_globals.keys())}")
        

        # 1. Check direct result
        if is_compas_geometry(result):
            if result not in execution_context['scene_objects']:
                execution_context['scene_objects'].append(result)

        # 2. Check if result is iterable of geometry
        elif hasattr(result, '__iter__') and not isinstance(result, (str, bytes)):
            try:
                for item in result:
                    if is_compas_geometry(item) and item not in execution_context['scene_objects']:
                        execution_context['scene_objects'].append(item)
            except TypeError:
                # Not actually iterable (Box, Sphere, etc.)
                pass

        # 3. Check ALL variables for geometry (catches exec() creations)
        for var_name, var_value in safe_globals.items():
            # Skip builtins and special names
            if var_name.startswith('_') or var_name in [
                'print', 'len', 'range', 'list', 'dict', 'str', 'int', 'float', 'bool',
                'Box', 'Sphere', 'Point', 'Frame', 'Circle', 'Cylinder', 'Mesh',
                'scene_objects'
            ]:
                continue
            
            if is_compas_geometry(var_value):
                if var_value not in execution_context['scene_objects']:
                    execution_context['scene_objects'].append(var_value)


        # # AUTO-DETECT GEOMETRY CREATION
        # # Check if result is a COMPAS geometry object
        # if result is not None:
        #     # Check if result is a COMPAS geometry type
        #     result_type = type(result)
        #     geometry_added = False
            
        #     if any(result_type == geom_type for geom_type in COMPAS_GEOMETRY_TYPES):
        #         # Result is directly a geometry object
        #         if result not in execution_context['scene_objects']:
        #             execution_context['scene_objects'].append(result)
        #             geometry_added = True
        #     elif hasattr(result, '__iter__'):
        #         # Result might be a list/tuple of geometries
        #         for item in result:
        #             item_type = type(item)
        #             if any(item_type == geom_type for geom_type in COMPAS_GEOMETRY_TYPES):
        #                 if item not in execution_context['scene_objects']:
        #                     execution_context['scene_objects'].append(item)
        #                     geometry_added = True
        
        # # Also check for newly assigned variables that might be geometry
        # var_name = extract_last_assignment(code)
        # if var_name and var_name in safe_globals:
        #     var_value = safe_globals[var_name]
        #     var_type = type(var_value)

        #     # again, debugging:
        #     print(f"🔵 Variable '{var_name}': type={type(var_value)}, value={var_value}")
        #     print(f"🔵 isinstance({var_name}, Point): {isinstance(var_value, Point)}")
        #     print(f"🔵 type({var_name}) == Point: {type(var_value) == Point}")
            
        #     if any(var_type == geom_type for geom_type in COMPAS_GEOMETRY_TYPES):
        #         if var_value not in execution_context['scene_objects']:
        #             execution_context['scene_objects'].append(var_value)


        # Capture any new variables created
        for key, value in safe_globals.items():
            if not key.startswith('_') and key not in ['print', 'len', 'range', 'list', 'dict', 'str', 'int', 'float', 'bool', 
                                                     'Box', 'Sphere', 'Point', 'Frame', 'Circle', 'Cylinder', 'Mesh', 'scene_objects']:
                execution_context['user_variables'][key] = value
        
        # Get output
        output = stdout.getvalue()
        error_output = stderr.getvalue()
        
        # Collect all geometry currently in scene_objects (not just new ones)
        current_geometry = []
        for obj in execution_context['scene_objects']:
            if hasattr(obj, '__data__'):
                # Use COMPAS's built-in serialization
                serialized = json.loads(obj.to_jsonstring())
                current_geometry.append(serialized)
        
        response_data = {
            "success": True,
            "result": str(result) if result is not None else None,
            "output": output,
            "error": error_output,
            "geometry": current_geometry  # Send ALL geometry back
        }
        
        return response_data
        
    except Exception as e:
        return {
            "success": False, 
            "message": f"Execution error: {str(e)}",
            "error": str(e)
        }
        

@app.get("/api/geometry")
def get_current_geometry():
    """Return all geometry currently in the scene"""
    geometry_data = []
    for obj in execution_context['scene_objects']:
        if hasattr(obj, '__data__'):
            geometry_data.append(obj.__data__)
    
    return {"objects": geometry_data}

@app.post("/api/clear")
async def clear_scene():
    """Clear all geometry from the scene"""
    execution_context['scene_objects'].clear()
    return {"success": True, "message": "Scene cleared"}

@app.post("/api/reset")
async def reset_environment():
    """Reset the entire execution environment"""
    execution_context['scene_objects'].clear()
    execution_context['user_variables'].clear()
    return {"success": True, "message": "Environment reset"}

@app.get("/api/health")
def health_check():
    return {"status": "ok", "message": "COMPAS Web Viewport is running!"}

# Serve frontend files
app.mount("/", StaticFiles(directory="../frontend", html=True), name="frontend")

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)

print("🔍 DEBUG - Current scene objects:", len(execution_context['scene_objects']))
for i, obj in enumerate(execution_context['scene_objects']):
    print(f"  Object {i}: {type(obj)} - has __data__: {hasattr(obj, '__data__')}")
    if hasattr(obj, '__data__'):
        print(f"    Data: {obj.__data__}")



# Add a project root path
PROJECT_ROOT = Path("./projects")  # Will store all user projects
PROJECT_ROOT.mkdir(exist_ok=True)

@app.get("/api/files")
def list_files(path: str = ""):
    """List files and directories in a given path"""
    target_path = PROJECT_ROOT / path
    
    if not target_path.exists():
        # Return empty arrays, not error
        return {
            "path": path,
            "files": [],
            "directories": []
        }
    
    files = []
    directories = []
    
    for item in target_path.iterdir():
        if item.is_file() and item.suffix == ".py":
            files.append({
                "name": item.name,
                "path": str(item.relative_to(PROJECT_ROOT)),
                "size": item.stat().st_size,
                "modified": item.stat().st_mtime
            })
        elif item.is_dir():
            directories.append({
                "name": item.name,
                "path": str(item.relative_to(PROJECT_ROOT))
            })
    
    return {
        "path": path,
        "files": files,  # This will be [] if empty
        "directories": directories  # This will be [] if empty
    }

@app.get("/api/file/{filepath:path}")
def read_file(filepath: str):
    """Read a Python file"""
    target_path = PROJECT_ROOT / filepath
    
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    with open(target_path, 'r') as f:
        content = f.read()
    
    return {
        "path": filepath,
        "content": content
    }

@app.post("/api/file/{filepath:path}")
def save_file(filepath: str, file_data: dict):
    """Save a Python file"""
    target_path = PROJECT_ROOT / filepath
    
    # Ensure directory exists
    target_path.parent.mkdir(parents=True, exist_ok=True)
    
    content = file_data.get("content", "# New COMPAS script\n")
    target_path.write_text(content)
    
    return {
        "success": True, 
        "message": "File saved",
        "path": filepath,
        "size": len(content)
    }

@app.delete("/api/file/{filepath:path}")
def delete_file(filepath: str):
    """Delete a file or directory"""
    target_path = PROJECT_ROOT / filepath
    
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    
    if target_path.is_file():
        target_path.unlink()
    else:
        shutil.rmtree(target_path)
    
    return {"success": True, "message": "Deleted"}

@app.post("/api/folder/{path:path}")
def create_folder(path: str, folder_data: dict):
    """Create a new folder"""

    if folder_data is None:
        folder_data = {}

    folder_name = folder_data.get("name", "New Folder")
    target_path = PROJECT_ROOT / path / folder_name
    
    if target_path.exists():
        raise HTTPException(status_code=400, detail="Folder already exists")
    
    target_path.mkdir(parents=True, exist_ok=True)
    
    return {"success": True, "message": "Folder created", "path": str(target_path.relative_to(PROJECT_ROOT))}


print(f"🔍 PROJECT_ROOT: {PROJECT_ROOT}")
print(f"🔍 PROJECT_ROOT exists: {PROJECT_ROOT.exists()}")
print(f"🔍 PROJECT_ROOT is directory: {PROJECT_ROOT.is_dir()}")
print(f"🔍 Contents of PROJECT_ROOT: {list(PROJECT_ROOT.iterdir()) if PROJECT_ROOT.exists() else 'DOES NOT EXIST'}")

# create default files
def create_default_files():
    """Create sample Python files if project is empty"""
    sample_files = {
        "examples/boxes.py": """# Create boxes
from compas.geometry import Box

# Simple box
box1 = Box.from_width_height_depth(2, 1, 0.5)
box1.frame.point = [0, 0, 0]

# Another box
box2 = Box.from_width_height_depth(1, 1, 1)
box2.frame.point = [3, 0, 0]

scene_objects.extend([box1, box2])
print("Created 2 boxes!")
""",
        
        "examples/spheres.py": """# Create spheres
from compas.geometry import Sphere

sphere1 = Sphere([0, 0, 0], 1)
sphere2 = Sphere([3, 0, 0], 0.5)

scene_objects.extend([sphere1, sphere2])
print("Created 2 spheres!")
""",
        
        "main.py": """# Main COMPAS script
from compas.geometry import Box, Sphere, Point

# Welcome to COMPAS Web Viewport!
print("Welcome to COMPAS Web Viewport!")

# Create some geometry
box = Box.from_width_height_depth(2, 1, 0.5)
sphere = Sphere([3, 0, 0], 1)
point = Point(0, 2, 0)

scene_objects.extend([box, sphere, point])
print(f"Added {len(scene_objects)} objects to scene")
"""
    }
    
    for filepath, content in sample_files.items():
        full_path = PROJECT_ROOT / filepath
        full_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Only create if doesn't exist
        if not full_path.exists():
            full_path.write_text(content)
            print(f"📁 Created sample file: {filepath}")

# Call this after PROJECT_ROOT is defined
create_default_files()


@app.post("/api/test-folder")
async def test_create_folder():
    """Test folder creation"""
    test_path = PROJECT_ROOT / "test_folder"
    test_path.mkdir(exist_ok=True)
    return {"success": True, "message": "Test folder created"}

@app.get("/api/test-list")
async def test_list_files():
    """Test listing files"""
    files = []
    directories = []
    
    for item in PROJECT_ROOT.iterdir():
        if item.is_file():
            files.append(item.name)
        else:
            directories.append(item.name)
    
    return {
        "files": files,
        "directories": directories
    }

@app.on_event("startup")
async def print_routes():
    """Print all available routes on startup"""
    print("\n" + "="*50)
    print("AVAILABLE ROUTES:")
    print("="*50)
    for route in app.routes:
        if hasattr(route, "methods"):
            print(f"{', '.join(route.methods):10} {route.path}")
    print("="*50 + "\n")