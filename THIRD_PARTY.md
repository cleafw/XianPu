# 参考项目与依赖

## 随软件使用

- [alphaTab 1.8.4](https://github.com/CoderLine/alphaTab/tree/v1.8.4) · MPL-2.0。以 npm 依赖接入，负责谱式渲染和 SoundFont 试听。对应上游源码可从其仓库获取。
- [Bravura](https://github.com/steinbergmedia/bravura) · SIL OFL 1.1。随 alphaTab 分发的音乐字形。
- [React 与 React DOM](https://github.com/facebook/react) · MIT。工作台界面。
- [Tauri](https://github.com/tauri-apps/tauri) · MIT 或 Apache-2.0。Windows 宿主与本地文件对话框。WebView2 运行时由 Microsoft 提供。
- JavaScript 和 Rust 的具体依赖版本记录在各自的锁定文件中。

- **NeuralNote GM** · 直接复用本机 NeuralNote 构建的 General MIDI 音色库，含 65 个旋律与效果预设及 1 套鼓组。音色取自 MuseScore General 和 FluidR3Mono，随安装包提供两份 MIT 许可与署名。[MuseScore General 音色来源](https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/) · [FluidR3Mono 音色来源](https://github.com/musescore/MuseScore/tree/45924076871483cb96b859cc374c5fbdbf76ba53/share/sound)

## 用于参考

- [悦谱 Dolce](https://github.com/lodebar2026/dolce) · MIT。简谱录入、歌词和常用排版。
- [Tabst](https://github.com/LIUBINfighter/Tabst.app) · MPL-2.0。alphaTab 预览和纸面打印流程。
- [TuxGuitar](https://github.com/helge17/tuxguitar) · LGPL。吉他弦品录入和演奏记号。
- [MuseScore Studio](https://github.com/musescore/MuseScore) · GPL-3.0。联动分谱和版式管理。
- [JianZiPu](https://github.com/neuralfirings/JianZiPu) · 字体 OFL-1.1，构建器 GPL-3.0。后续古琴减字谱参考。

项目工程格式、编辑交互和打印分页为独立实现。
