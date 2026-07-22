export default function ThinkingShimmer({ text = 'Thinking...' }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2" role="status" aria-live="polite">
      <span className="text-sm font-medium tracking-wide thinking-shimmer">
        {text}
      </span>
    </div>
  )
}
