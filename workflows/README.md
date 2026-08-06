# workflows/

本目录存放 ComfyUI 工作流文件（**API 格式** JSON），命名规则：

- `W1_concept.json` 概念原画
- `W2_depth.json` 深度图
- `W3_material.json` 3D 贴图材质
- `W4_music.json` 背景音乐
- `W5_sfx.json` 环境音效
- `W6_sprite.json` 序列帧图集
- `W7_twin.json` 动态孪生

如何导出 API 格式：在 ComfyUI 中编辑好工作流后，菜单 `Workflow → Export (API)`。

每个工作流文件内应记录默认参数；任务提交时由后端覆盖 prompt / seed 等可变量。

> 当前阶段（P0）尚未生成工作流，P1 阶段在本地 ComfyUI 中搭建后回填。
