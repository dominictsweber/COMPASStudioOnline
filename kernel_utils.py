
import json
import inspect
import pickle
import base64

# This code is injected into the Jupyter Kernel to Introspect variables
# and serialize them for the frontend.

def _serialize_compass_data():
    class COMPASEncoder(json.JSONEncoder):
        def default(self, obj):
            if hasattr(obj, '__iter__'):
                return list(obj)
            if hasattr(obj, 'to_data'):
                return obj.to_data()
            try:
                return super().default(obj)
            except TypeError:
                return str(obj)

    _vp_objects = []
    
    # Helper to get mesh data
    def _get_mesh_data(obj):
        # Try standard mesh/shape method
        if hasattr(obj, 'to_vertices_and_faces'):
            try:
                _v, _f = obj.to_vertices_and_faces()
                return {'vertices': [list(pt) for pt in _v], 'faces': _f}
            except: pass
        
        # Try converting Primitive/Shape to Mesh
        try:
            from compas.datastructures import Mesh
            _m = Mesh.from_shape(obj)
            _v, _f = _m.to_vertices_and_faces()
            return {'vertices': [list(pt) for pt in _v], 'faces': _f}
        except: pass
        return None

    # Recursive extractor
    def _extract_vp_items(name, obj, depth=0):
        if depth > 3: return [] # Safety limit
        
        items = []
        
        # 1. Try to render the object itself
        data = _get_mesh_data(obj)
        if data:
            # Check if global
            _is_global = name.startswith('glb_')
            return [{'name': name, 'type': 'Mesh', 'data': data, 'isGlobal': _is_global}]
            
        # 2. Handle Lists (Explicitly requested)
        if isinstance(obj, list):
            for i, item in enumerate(obj):
                # Recursive call with indexed name. Dictionaries are ignored.
                items.extend(_extract_vp_items(f"{name}[{i}]", item, depth+1))
                
        return items

    # Main Loop
    _prev_injected = globals().get('_injected_globals', set()) 
    
    for _name, _obj in list(globals().items()):
        if _name.startswith('_'): continue
        if inspect.ismodule(_obj): continue
        if inspect.isclass(_obj): continue
        if inspect.isfunction(_obj): continue
        
        # If global and injected, skip
        if _name.startswith('glb_') and _name in _prev_injected:
             continue 

        # Extract
        items = _extract_vp_items(_name, _obj)
        _vp_objects.extend(items)

    return _vp_objects

def _serialize_globals():
    _new_globals = {}
    _prev_injected = globals().get('_injected_globals', set()) 

    for _name in list(globals().keys()):
        if _name.startswith('glb_'):
            # Skip if it was injected (not created here)
            if _name in _prev_injected:
                continue
                
            try:
                _val = globals()[_name]
                # Verify it can be pickled (skip modules/lambdas)
                _start = pickle.dumps(_val) 
                _b64 = base64.b64encode(_start).decode('utf-8')
                _new_globals[_name] = _b64
            except Exception:
                pass
    return _new_globals

print('<<<VP_DATA_START>>>')
try:
    print(json.dumps(_serialize_compass_data()))
except Exception as e:
    print(json.dumps({"error": str(e), "trace": "Serialization Failed"}))
print('<<<VP_DATA_END>>>')

print('<<<GLOBALS_START>>>')
try:
    print(json.dumps(_serialize_globals()))
except Exception as e:
    print(json.dumps({}))
print('<<<GLOBALS_END>>>')
