# Agent Note: 直连知识检索协议

Status: implemented

[English](2026-10-31-direct-knowledge-retrieve-protocol.md) | 中文

## 问题

企业知识库原先发送旧的单问题响应协议，而部署中的知识服务提供的是直连 `knowledge_search_api/retrieve` 接口。旧请求丢失了会话方法状态，响应也没有充分性、冲突、方法和来源分组信号。

## 决定

企业知识库使用每个逻辑来源配置的直连 retrieve 地址。Host 注入批准的 `space_ids`，发送完整的 user/assistant `messages` 历史，并在有值时携带 `emotion`、`prev_method_id`、`verify`、图片、来源和过滤控制。直连接口是内部免鉴权服务；本包不配置或转发 bearer token。

Host 校验 retrieve 外壳和批准的文档空间，保留 `chunks`、`images`、`im`、`graph` 分组结果及检索信号供 Cloud Agent 执行，同时只通过管理 Remote 暴露有界的证据字段。Cloud Agent 运行时在检索前从当前 Session 推导 user/assistant 文本消息；继续服务端方法时由调用方传入 `prev_method_id`。

## 考虑过的替代方案

**继续使用旧的 `query` 请求，再在适配器中转换到新接口。** 这会丢失多轮方法连续性，也无法让模型使用 `verify`、来源选择和直连响应信号。

**通过浏览器 Remote 暴露完整 retrieve 响应。** 这会把内部来源分组和无界上游字段发布到客户端。Host 将详细结果保留在同进程执行结果中，通过管理 API 返回有界证据。

## 影响

部署必须提供直连 retrieve 地址和批准的空间 id。由于本集成不增加请求鉴权，内部接口必须由部署网络保护。检索测试覆盖多轮请求字段、方法信号、来源分组、过滤和响应校验。
