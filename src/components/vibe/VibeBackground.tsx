import { useEffect, useState } from 'react'
import { useVibeStore, DEFAULT_VIBE_BACKGROUND } from '../../stores/vibe-store'
import { ipc } from '../../lib/ipc-client'
import { toFileUrl } from '../../lib/file-url'

export default function VibeBackground() {
  const background = useVibeStore((s) => s.background)
  const setBackground = useVibeStore((s) => s.setBackground)
  const [src, setSrc] = useState(background.value)
  const [fade, setFade] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFade(false)

    const resolveSrc = async () => {
      if (background.type === 'local') {
        const exists = await ipc.fileExists(background.value)
        if (cancelled) return
        if (!exists) {
          setBackground(DEFAULT_VIBE_BACKGROUND)
          setSrc(DEFAULT_VIBE_BACKGROUND.value)
          return
        }
        setSrc(toFileUrl(background.value))
      } else {
        if (cancelled) return
        setSrc(background.value)
      }
    }

    void resolveSrc()

    return () => {
      cancelled = true
    }
  }, [background, setBackground])

  const handleError = () => {
    if (src !== DEFAULT_VIBE_BACKGROUND.value) {
      setBackground(DEFAULT_VIBE_BACKGROUND)
      setSrc(DEFAULT_VIBE_BACKGROUND.value)
    }
  }

  return (
    <div className="fixed inset-0 z-0">
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat transition-opacity duration-700"
        style={{
          backgroundImage: `url(${JSON.stringify(src)})`,
          opacity: fade ? 1 : 0,
        }}
      />
      <img
        src={src}
        alt=""
        className="hidden"
        onLoad={() => setFade(true)}
        onError={handleError}
      />
      {/* Dark overlay for readability */}
      <div className="absolute inset-0 bg-black/30" />
    </div>
  )
}
