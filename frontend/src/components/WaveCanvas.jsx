import React, { useRef, useEffect } from 'react'

/*
Props:
- data: number[] (波形點)
- width: number (預設 600)
- height: number (預設 100)
- color: string (預設 '#00b4d8')
*/
export default function WaveCanvas({ data = [], width = 600, height = 120, color = '#00b4d8' }) {
  const canvasRef = useRef(null)
  const latestDataRef = useRef([])

  // keep latest in ref to avoid heavy deps in RAF loop
  useEffect(() => {
    latestDataRef.current = data
  }, [data])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let rafId = null

    const draw = () => {
      const arr = latestDataRef.current || []
      // clear
      ctx.clearRect(0, 0, width, height)
      // background (optional)
      ctx.fillStyle = '#0b1724'
      ctx.fillRect(0, 0, width, height)

      if (arr.length === 0) {
        // draw placeholder text
        ctx.fillStyle = '#6b7280'
        ctx.font = '12px sans-serif'
        ctx.fillText('等待波形資料...', 10, height / 2)
      } else {
        // simple downsample: pick at most one point per pixel
        const maxPoints = Math.max(2, width)
        const step = Math.max(1, Math.ceil(arr.length / maxPoints))
        ctx.beginPath()
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5

        // map values to canvas vertical range
        let min = Infinity, max = -Infinity
        for (let i = 0; i < arr.length; i += step) {
          const v = arr[i]
          if (v < min) min = v
          if (v > max) max = v
        }
        if (min === Infinity) { min = -1; max = 1 }
        const range = (max - min) || 1

        const points = []
        for (let i = 0; i < arr.length; i += step) {
          const v = arr[i]
          const x = (points.length / (Math.ceil(arr.length / step) - 1 || 1)) * width
          const y = height - ((v - min) / range) * height
          points.push({ x, y })
        }

        // draw polyline
        if (points.length > 0) {
          ctx.moveTo(points[0].x, points[0].y)
          for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y)
          }
        }
        ctx.stroke()
      }

      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [width, height, color])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ display: 'block', width: `${width}px`, height: `${height}px`, borderRadius: 4 }}
    />
  )
}

