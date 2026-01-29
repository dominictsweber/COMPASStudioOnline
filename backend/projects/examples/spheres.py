# Create spheres
from compas.geometry import Sphere

sphere1 = Sphere([0, 0, 0], 1)
sphere2 = Sphere([3, 0, 0], 0.5)

scene_objects.extend([sphere1, sphere2])
print("Created 2 spheres!")
