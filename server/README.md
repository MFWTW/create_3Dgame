# server/

后端服务（计划使用 FastAPI），职责：

- 任务队列：接收前端请求，调用 ComfyUI `/prompt` 提交工作流
- 状态轮询：`/history/{id}` 查询执行结果
- 结果代理：`/view` 转发生成图片/音频给前端
- WebSocket：转发 ComfyUI 执行进度
- SQLite：项目、任务、资产记录

> P2 阶段开始实现；接口草案见根目录 README「后端 API（草案）」。
