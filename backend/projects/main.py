# Main COMPAS script
from compas.geometry import Box, Sphere, Point

# Welcome to COMPAS Web Viewport!
print("Welcome to COMPAS Web Viewport!")

# Create some geometry
box = Box.from_width_height_depth(2, 1, 0.5)
sphere = Sphere([3, 0, 0], 1)
point = Point(0, 2, 0)

scene_objects.extend([box, sphere, point])
print(f"Added {len(scene_objects)} objects to scene")
