---
title: 叶子弦谱编辑和记谱改进
type: feature
created: '2026-11-10'
status: done
route: dispatch
baseline_commit: '64aea63b0ad964ced0e79af400b4823d2295d75c'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent">
## Intent

按已评审的 A 至 E 批次改进真实乐谱编辑。优先补齐升降八度和拖选、复制粘贴，随后完成记号、曲式、乐器专项和总分谱交付。

## Boundaries & Constraints

保持旧工程可打开，保留同一工程内总分谱联动，新增内容进入撤销和导出。古琴减字谱和外部格式交换按规划范围处理。
</frozen-after-approval>

## Code Map

- src/ScoreView.tsx、src/main.tsx、src/measureClipboard.ts · 谱面定位、选区、复制与粘贴。
- src/Editor.tsx、src/notationMarks.ts、src/score.ts · 音符操作、记号库和谱面。
- src/model.ts、src/playback.ts、src/PrintSheet.tsx · 工程、试听和分页。
- [批次和验收细则](../planning-artifacts/score-editing-improvement-plan.md)

## Tasks & Acceptance

- [x] A · 选音升降八度，连续拖选和跳选，覆盖或插入，取消安全且可撤销。
- [x] B · 记号可搜索、添加、删除，跟随音符或范围，保存与导出。
- [x] C · 反复、房子、跳转的实际试听顺序可验证。
- [x] D · 乐器技巧和歌词可以编辑、排版并导出。
- [x] E · 同源对照谱和分谱设置可使用并验证。

## Implementation Notes

- A 实现谱面和小节条拖选。剪贴板保留节奏、歌词、技法及完整范围，支持整段总谱和各独立声部。
- B 实现可搜索的符号库、偏移、跨行渐强及自定义文字／线条。倚音有独立音高，连音符按组编辑。
- C 实现基本反复、第一／第二房、D.C.／D.S.、Fine、Coda、排练号和小节重复。试听按曲式生成音符顺序。
- D 增加专用技法组、谱头说明、多段歌词、逐弦记号及变调夹。民乐特殊技法保留谱面标记，拟真试听和逐个谱本字形校对继续按原计划扩充。
- E 实现对照谱、大谱表、独立声部、谱号、移调、鼓谱、分谱换行换页、页眉页脚和选用的长休止合并。

## Spec Change Log

## Review Triage Log

- 已修复两处保存一致性问题。记号偏移取整数，范围端点数量按工程校验上限保护。
- 已修复拖选跨窗口滚动、待完成范围遇到结构编辑、分手谱表原音定位、粘贴确认与撤销冲突及连音组的清除。
- 已修复曲式粘贴造成后续拍数溢出的提示、双小节重复的拆分保护、返回段速度继承和仅相同弦／音高应用延音线。
- 已修复 PNG 页脚和长休止压缩可能覆盖和弦、记号或曲式的问题。
- 当前试听规则为一条 D.C. 或 D.S. 跳转，第一／第二房采用两遍反复。复杂多跳转、出版社逐符号校样与高级民乐拟真属于后续范围。

## 后续需求 · 试听跟随与悬浮面板

- 播放位置根据合成器的实际 MIDI tick 映射到反复展开后的谱面小节与音符位置。光标离开可视区时滚动谱面。停播后回到独立的录入选择。
- 时值、音高、歌词与和弦、连线与常用技巧、倚音与成组连音和记号面板可独立折叠、弹出、拖动与贴回。打开临时对话框期间保留面板状态。
- 验收覆盖跨谱行滚动、反复回跳、两个悬浮面板同时操作，以及贴回后保留当前搜索。

## Verification

- npm test 通过 22 项，Playwright 通过 17 项。TypeScript、生产构建与 Windows x64 构建通过。
- Windows 本地试用版已启动到首页。原生文件对话框与 PDF 批量导出的自动回归本轮未完成。
