# Product

## Register

product

## Users

正在 Pi 中执行 coding task 的开发者，需要在主任务不中断的情况下快速询问上下文问题，并在同一个 terminal transcript 中看到答案。

## Product Purpose

`pi-btw` 提供隔离的 side question：旁问使用主会话上下文回答，但不把旁问文本写回主 LLM context。T8 关注 TUI 展示层，确保答案默认可见、overlay 不透屏、长答案可继续阅读。

## Brand Personality

直接、克制、可靠。

## Anti-references

不要隐藏答案、不要要求用户为每个完成的旁问额外打开 fullscreen overlay；不要让 overlay 透出底层 transcript；不要引入新的 modal flow 或改变 RPC/host contract 来解决 TUI 显示问题。

## Design Principles

- 先显示答案，再提供全文阅读入口。
- 主任务始终保持连续，side question 只占据必要的视觉区域。
- 持久 entry、inline card 和 overlay 使用一致的边框、背景和宽度规则。
- 展示层修复不改变 entry data schema、RPC 事件或 host contract。

## Accessibility & Inclusion

键盘操作优先，Esc 能退出 overlay，↑↓ 能滚动；CJK 文本按 terminal visible width 计算；每个 overlay 行都必须有不透明背景，避免信息与底层内容混叠。
