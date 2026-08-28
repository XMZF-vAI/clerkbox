import { Download, Code2, Check } from 'lucide-react';
import { useReveal } from '../hooks/useReveal';

export function DownloadSection() {
  const { ref: headRef, revealed: headIn } = useReveal<HTMLDivElement>(0.1);
  const { ref: cardRef, revealed: cardIn } = useReveal<HTMLDivElement>(0.1);

  return (
    <section id="download" className="px-6 py-24 lg:px-10 lg:py-32">
      <div className="mx-auto max-w-7xl">
        <div
          ref={headRef}
          className={`mb-14 max-w-2xl transition-all duration-700 ease-md3-emphasized ${
            headIn ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0'
          }`}
        >
          <div className="section-label mb-3">04 — Download</div>
          <h2 className="text-4xl font-black tracking-tight text-md3-on-surface sm:text-5xl">开始使用</h2>
          <p className="mt-4 text-lg text-md3-on-surface-variant">
            Windows 10 / 11 (x64)。NSIS 安装包，可选安装路径，自动创建快捷方式。覆盖安装自动保留会话数据。
          </p>
        </div>

        <div
          ref={cardRef}
          className={`max-w-xl transition-all duration-700 ease-md3-emphasized ${
            cardIn ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
          }`}
        >
          <div className="card-elevated flex flex-col p-8 sm:p-10">
            <div className="mb-5 flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-md3-lg bg-md3-primary-container text-md3-on-primary-container shadow-md3-1">
                <Download size={24} />
              </div>
              <div>
                <div className="section-label">NSIS Installer</div>
                <h3 className="text-2xl font-bold text-md3-on-surface">安装版</h3>
              </div>
            </div>
            <p className="mb-2 font-mono text-sm text-md3-on-surface-variant">ClerkBox.Setup.1.7.0.exe</p>
            <ul className="mb-8 flex flex-wrap gap-2">
              {['~90 MB', '可选安装路径', '桌面快捷方式', '开始菜单', '含卸载器'].map((t) => (
                <li key={t} className="flex items-center gap-1.5 rounded-md3-sm bg-md3-surface-container px-3 py-1 text-xs text-md3-on-surface-variant">
                  <Check size={12} className="text-md3-primary" /> {t}
                </li>
              ))}
            </ul>
            <div className="mt-auto flex flex-col gap-3 sm:flex-row sm:items-center">
              <a
                href="https://gh.jasonzeng.dev/https://github.com/XMZF-vAI/clerkbox/releases/download/v1.7.0/ClerkBox.Setup.1.7.0.exe"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-filled flex-1 sm:flex-none"
              >
                <Download size={18} /> 国内加速
              </a>
              <a
                href="https://github.com/XMZF-vAI/clerkbox/releases/download/v1.7.0/ClerkBox.Setup.1.7.0.exe"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-outlined flex-1 sm:flex-none"
              >
                <Download size={18} /> GitHub 原链
              </a>
            </div>
          </div>
        </div>

        <div className="mt-10 overflow-hidden rounded-md3-xl border border-md3-outline-variant bg-md3-inverse p-6 text-md3-inverse-on-surface shadow-md3-3 sm:p-8">
          <div className="mb-4 flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-white/50">
            <Code2 size={14} /> 从源码构建
          </div>
          <code className="block font-mono text-sm leading-7 text-white/90">
            <span className="text-md3-tertiary-container">$</span> git clone https://github.com/XMZF-vAI/clerkbox.git<br />
            <span className="text-md3-tertiary-container">$</span> cd ClerkBox && npm install<br />
            <span className="text-md3-tertiary-container">$</span> npm run dev <span className="text-white/40"># 开发模式</span><br />
            <span className="text-md3-tertiary-container">$</span> npm run build <span className="text-white/40"># 生成 NSIS 安装包</span>
          </code>
        </div>
      </div>
    </section>
  );
}
