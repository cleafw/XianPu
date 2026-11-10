---
version: v0.1
name: 叶子弦谱
description: 中文 Windows 写谱工作台
colors:
  ink: "#1a2925"
  muted: "#526660"
  paper: "#ffffff"
  canvas: "#f2f4ef"
  panel: "#fbfcf9"
  accent: "#126252"
  selected: "#e3f1e9"
  border: "#d7e0d9"
  warning: "#835214"
  error: "#a62829"
typography:
  interface:
    fontFamily: Segoe UI, Microsoft YaHei UI, sans-serif
    fontSize: 14px
  caption:
    fontFamily: Segoe UI, Microsoft YaHei UI, sans-serif
    fontSize: 12px
  homepageTitle:
    fontFamily: Segoe UI, Microsoft YaHei UI, sans-serif
    fontSize: 56px
rounded:
  control: 7px
  card: 10px
spacing:
  control: 8px
  panel: 16px
components:
  template:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
  primaryButton:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
  paper:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
---
# 叶子弦谱界面设计

## Brand & Style

把纸面作为视觉中心。界面采用深青按钮和暖灰绿背景，这是实施时根据用户授权选定的设计方向。

## Colors

主操作使用 {colors.accent}。选中状态同时显示 {colors.selected} 和文字。拍数不足用 {colors.warning}，超出用 {colors.error}，同时说明差值。正文与普通操作文字以 WCAG AA 4.5:1 为对比度目标。

## Typography

界面优先使用系统中文字体。作品名在纸面使用排版引擎的标题样式。弦号、品位、音级使用易辨认的数字。速度用 BPM 明确单位。

## Layout & Spacing

首页在同一行显示三个模板，后接示例入口。工作台包含固定工具栏、乐器导航、可滚动谱面和录入面板。低于 1060 像素时缩窄侧栏，谱面区域可横向滚动。A4 预览以单页卡片展示。

## Components

| 组件 | 视觉规则 |
| --- | --- |
| 模板卡 | 谱式样例在上，标题、用途与新建动作在下 |
| 主工具栏 | 「导出 PDF」为主按钮，试听与保存保持可见 |
| 乐器导航 | 总谱和分谱分组，选中分谱有背景与字重变化 |
| 谱面与拍位 | 白纸、深色谱号、青色拍位光标 |
| 录入面板 | 时值、音高或弦品、歌词与记号分区 |
| 导出对话框 | 范围和保存按钮置顶，实际纸张页居中 |
| 状态反馈 | 小节拍数差在录入区显示，文件结果置于状态栏，错误提供可关闭说明 |

视觉规范和体验规范优先于原型与实现截图。
