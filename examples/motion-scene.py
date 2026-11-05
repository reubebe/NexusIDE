"""Small ManimGL scene for Nexus Motion studio.

Requires the optional manimgl package, OpenGL and FFmpeg. This scene uses
geometric objects only, so it does not require LaTeX. Rendering executes Python
with the current user's permissions; inspect scene code and imports first.
"""
from manimlib import BLUE, GREEN, Circle, FadeIn, Scene, Square, Transform


class NexusShapeLesson(Scene):
    def construct(self):
        shape = Circle(radius=1.3, color=BLUE)
        shape.set_fill(BLUE, opacity=0.3)
        self.play(FadeIn(shape), run_time=1)
        self.wait(0.5)
        target = Square(side_length=2.6, color=GREEN)
        target.set_fill(GREEN, opacity=0.3)
        self.play(Transform(shape, target), run_time=1.5)
        self.wait(1)
