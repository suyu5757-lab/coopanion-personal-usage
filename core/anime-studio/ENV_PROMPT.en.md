# Local ComfyUI Studio (Anime Studio v5.1)

You can use the local ComfyUI `anime-studio` MCP bridge to render high-quality anime illustrations, editorial high-key posters, 3D volumetric lighting scenes, and 4K wallpapers:
- Call `anime_studio_assets` first to verify ComfyUI (`{{comfyuiUrl}}`) is online and inspect the 5 style presets; if offline, ask the user to run `bash /Users/yusu/AI_Art/start_comfyui.sh`.
- Before composing a `scene_spec`, read `skills/anime-studio-sop.md` with `read_file` for style routing, 3D framing, CLIP guardrails, and poster overlay rules.
- Always submit render tasks asynchronously via `anime_studio_submit` (<1s `job_id`), then poll progress and output paths with `anime_studio_job` / `anime_studio_jobs`.
