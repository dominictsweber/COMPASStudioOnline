
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
    # Look for anything with to_vertices_and_faces (Shapes, Meshes)
    for _name, _obj in list(globals().items()):
        if _name.startswith('_'): continue
        if inspect.ismodule(_name): continue
        if inspect.isclass(_name): continue
        if inspect.isfunction(_name): continue
        
        _data = None
        _type = 'Mesh'

        # Try standard mesh/shape method
        if hasattr(_obj, 'to_vertices_and_faces'):
            try:
                _v, _f = _obj.to_vertices_and_faces()
                _v_list = [list(pt) for pt in _v]
                _data = {'vertices': _v_list, 'faces': _f}
            except: pass
        
        # Try converting Primitive/Shape to Mesh if needed (COMPAS 1.x style)
        if _data is None:
            try:
                from compas.datastructures import Mesh
                _m = Mesh.from_shape(_obj)
                _v, _f = _m.to_vertices_and_faces()
                _v_list = [list(pt) for pt in _v]
                _data = {'vertices': _v_list, 'faces': _f}
            except: pass    

        # Handle Lists of Objects
        if _data is None and isinstance(_obj, list):
            try:
                # Combine multiple meshes into one for visualization (or return list of meshes?)
                # Viewport manager expects a single geometry payload per "name".
                # To support lists, we can merge them into one "Mesh" payload, or update viewport.js to handle arrays.
                # Merging is safer for now without changing frontend protocol drastically.
                
                # Check if elements are renderable
                _all_v = []
                _all_f = []
                _v_offset = 0
                _has_valid_items = False
                
                for _item in _obj:
                    # Get geom for item
                    _i_v, _i_f = [], []
                    
                    if hasattr(_item, 'to_vertices_and_faces'):
                        try:
                            _raw_v, _raw_f = _item.to_vertices_and_faces()
                            _i_v = [list(p) for p in _raw_v]
                            _i_f = _raw_f
                        except: pass
                    else:
                        try:
                             from compas.datastructures import Mesh
                             _m = Mesh.from_shape(_item)
                             _raw_v, _raw_f = _m.to_vertices_and_faces()
                             _i_v = [list(p) for p in _raw_v]
                             _i_f = _raw_f
                        except: pass

                    if _i_v and _i_f:
                        _has_valid_items = True
                        # Append Vertices
                        _all_v.extend(_i_v)
                        # Append Faces (adjusted indices)
                        for face in _i_f:
                            _all_f.append([idx + _v_offset for idx in face])
                        
                        _v_offset += len(_i_v)
                
                if _has_valid_items:
                    _data = {'vertices': _all_v, 'faces': _all_f}
                    _type = 'MeshList' # Treated as single mesh by frontend
            except: pass

        if _data:
            # Determine if Global or Local
            _is_global = _name.startswith('glb_')
            
            # Avoid duplicating globals if they were injected (not created here)
            _prev_injected = locals().get('_injected_globals', set()) 
            # Only skip if it is exactly the injected name AND likely unchanged
            if _is_global and _name in _prev_injected:
                 continue # Skip visualization of imported globals to avoid duplicates
            
            _vp_objects.append({'name': _name, 'type': _type, 'data': _data, 'isGlobal': _is_global})

    return _vp_objects

def _serialize_globals():
    _new_globals = {}
    _prev_injected = locals().get('_injected_globals', set()) 

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
print(json.dumps(_serialize_compass_data()))
print('<<<VP_DATA_END>>>')

print('<<<GLOBALS_START>>>')
print(json.dumps(_serialize_globals()))
print('<<<GLOBALS_END>>>')
