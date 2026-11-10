# 叶子弦谱 · Yezi XianPu

用于中文弹唱、吉他指弹和小型乐队的 Windows 离线写谱工作台。

## 开始写谱

1. 使用 [Windows x64 离线安装包](artifacts/Yezi-XianPu-0.3.0-win-x64-setup.exe)，启动「叶子弦谱」。桌面快捷方式同名。
2. 点「打开弹唱示例」查看八小节混排，也可打开 [沿着晚风工程](examples/沿着晚风.xianpu)。要从头写歌，选择「简谱弹唱」「吉他指弹」或「多乐器总谱」。
3. 直接点总谱上目标声部的拍位，录入面板会切换到该声部。「录入位置」也可用于键盘操作。简谱用数字输入，吉他先选弦再加入品位，五线谱可点录入面板里的谱线。右侧可设置时值、歌词、和弦和演奏记号。
4. 左栏从总谱切到各乐器。音符共用，分谱可单独设置每行小节数和每页谱行数。
5. 保存为 `.xianpu`。点「导出 PDF」预览纸张，选择当前谱、总谱或多份分谱。批量输出遇到同名文件会停止，并说明已经输出几份。
6. 左栏「试听音色」可为每个声部分配不同音色，也可一键统一。内置 66 个 NeuralNote 试听音色，包括合唱人声。合唱音色用元音演奏旋律。
7. 左栏底部「纸张设置」可选 A4、A3 或填写自定义宽高。分谱默认跟随总谱，也可单独设置。纸张尺寸用于排版、预览与 PDF。

右上角可选「跟随系统」「简体中文」或「English」。跟随系统时，Windows 中文界面使用简体中文，其他语言使用英文。手动选择会记住。项目中的曲名、歌词和乐器名按原文保留。

## 构建和检查

- 运行 `npm ci` 安装依赖。
- 运行 `npm run desktop -- dev` 启动桌面开发版，或运行 `npm run dev` 检查界面。
- 运行 `npm test` 检查工程数据，运行 `npx playwright test` 使用本机 Edge 检查编辑流程。
- 运行 `npm run desktop -- build --target x86_64-pc-windows-msvc` 构建带 WebView2 离线安装程序的 NSIS 安装包。默认输出在 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis`。
- [界面设计](DESIGN.md) · [操作体验](EXPERIENCE.md) · [参考项目和依赖](THIRD_PARTY.md) · [界面与交付验收](docs/validation-report.md)

首版聚焦新建和编辑自己的工程。MusicXML、Guitar Pro 文件导入与古琴减字谱留在后续阶段。
