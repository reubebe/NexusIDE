# Animation rendering and synchronized video comparison

Open **Visualizations → Motion studio: animation and draft comparison** for two local workflows inspired by [ManimGL](https://github.com/3b1b/manim) and [NullMotion](https://github.com/blixvip/NullMotion). Nexus supplies the controls, project file checks, approval, cancellation and output receipts. External renderers remain optional installations.

## Render an explanatory animation

1. Put a reviewed Python scene in your project. The bundled `examples/motion-scene.py` contains `NexusShapeLesson`, a short circle-to-square animation without LaTeX.
2. In the animation form, enter the relative scene path, class name and absolute path of your installed `manimgl` executable. Use the **ManimGL** package from `3b1b/manim`; Manim Community is a separate implementation with different interfaces.
3. Select **Review and render animation** and read the approval. The script and its imports execute Python with your user permissions. Output-file checks do not sandbox that Python code.
4. The renderer uses a new `nexus-visual-output/motion-*` directory, low-quality preview settings and 24 frames per second. The completed output path is placed in the draft field for comparison. Use **Cancel render** to stop the process group.

ManimGL requires a separately installed Python environment, OpenGL, FFmpeg and ffprobe. LaTeX is required only for scenes using it. Nexus never installs a package, downloads a model or changes the environment as part of rendering. Relative imports or assets may need explicit paths because the working directory is the new output directory, not your project root.

A scene must be a singly linked `.py` file at most 100 KB inside the project. Its digest is checked after approval and after rendering. These checks detect observed edits to that file; they do not audit imported code or establish that an arbitrary Python script is safe. Render commands have a two-minute process limit and bounded diagnostic output. Failure receipts are retained when execution has started.

## Compare a source and draft

Enter two relative local video paths, then choose **Load comparison**. Source playback controls drive both videos' play, pause, seek and rate. Only source audio plays. The draft pauses the source when it ends. Synchronization corrects drift during playback; this is a review aid, not frame-accurate scientific measurement.

Inputs must be supported local containers: MP4, MOV, M4V, WebM or MKV. No remote URL, playlist, protected path, symlink or hard link is accepted. Render inputs have a 500 MB limit. Browser previews have a smaller 50 MB limit per file and load the media into memory. Codec support depends on the native webview or browser. An accepted container extension does not guarantee browser decoding; use H.264 MP4 when a local preview cannot play.

**Export side-by-side MP4** renders a fresh 1280 × 360 video, fitting each input into a 640 × 360 pane at 24 fps. The duration is greater than zero and at most 120 seconds, and the shorter input can end the export earlier. Source audio is included when present; draft audio is excluded. FFmpeg and ffprobe must already be installed. Original files are read and their hashes checked; the workflow does not intentionally overwrite or move them. Export uses FFmpeg, so it does not depend on the browser-only WebCodecs export used by NullMotion.

Before reporting a successful render, Nexus uses bounded ffprobe output to verify a video stream, dimensions and positive duration. Comparison exports also check the requested dimensions and duration bound. A render receipt records source digests, command arguments, exit/stopping state, observed video metadata and the output path or failure. Successful rendering does not establish visual fidelity, perceptual synchronization, correct mathematics or editorial approval. Review the video and its source evidence before sharing it.

## Validation and boundaries

The automated fixture suite covers denied approval, edits made during approval, fixed renderer arguments, failed and cancelled processes, non-video output despite a successful renderer exit, protected paths, symbolic/hard links and size limits. A synthetic executable tests the ManimGL invocation contract; it is not ManimGL. A real FFmpeg test creates two color clips, exports them side by side, checks dimensions and duration, and verifies both source hashes remain unchanged.

ManimGL was not installed on the validation machine when checked on 2026-11-05, so the example scene has not been rendered here. Its Python syntax can be checked without importing ManimGL. No claim of a completed real ManimGL render or upstream NullMotion feature parity is made.

The invocation options were checked against [ManimGL's command parser](https://github.com/3b1b/manim/blob/master/manimlib/config.py), including the distinct `manimgl` executable, `--write_file`, `--video_dir`, `--file_name` and `--config_file`. The comparison interaction follows NullMotion's shared-clock review idea; no upstream video assets or HTML scene execution are included.
