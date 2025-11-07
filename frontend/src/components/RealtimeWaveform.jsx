import { useState, useEffect, useRef } from 'react'
import PropTypes from 'prop-types'
import './RealtimeWaveform.css'

// 測站分組：東部、西部、離島三組
const STATION_GROUPS = {
  east: {
    title: '東部測站',
    stations: [
      'NOU', 'TIPB', 'ILA', 'TWC', 'ENT',
      'HWA', 'EGFH', 'EYUL', 'TTN', 'ECS', 'TAWH', 'HEN'
    ]
  },
  west: {
    title: '西部測站',
    stations: [
      'TAP', 'A024', 'NTS', 'NTY', 'NCU', 'B011',
      'HSN1', 'HSN', 'NJD', 'B131', 'TWQ1', 'B045',
      'TCU', 'WDJ', 'WHP', 'WNT1', 'WPL', 'WHY',
      'WCHH', 'WYL', 'WDL', 'WSL', 'CHY1', 'C095', 'WCKO',
      'TAI', 'C015', 'CHN1', 'KAU', 'SCS', 'SPT', 'SSD'
    ]
  },
  islands: {
    title: '離島測站',
    stations: ['PNG', 'KNM', 'MSU']
  },
      test_group: {
    title: '測試群組',
    stations: ['A009', 'A006', 'A007', 'A013', 'B122']  // 假設B122在北部
  },
}

const LAT_MAX = 25.4
const EAST_LAT_MIN = 21.2
const EAST_LAT_MAX = 25.4
const ISLANDS_PANEL_HEIGHT = 200
const PANEL_GAP = 8

// 時間軸設定
const TIME_WINDOW = 60 // 顯示 60 秒的數據（1 分鐘）
const SAMPLE_RATE = 100 // 100 Hz（每秒 100 個採樣點）

/**
 * 從 SEED 格式提取測站代碼
 * 格式：SM.{station}.01.HLZ -> {station}
 * 例如：SM.F028.01.HLZ -> F028, SM.TAP.01.HLZ -> TAP
 */
function extractStationCode(seedName) {
  if (!seedName) return seedName
  const parts = seedName.split('.')
  if (parts.length >= 2) {
    return parts[1] // 返回第二個部分（測站代碼）
  }
  return seedName // 如果格式不符，返回原始名稱
}

function GeographicWavePanel({ title, stations, stationMap, waveDataMap, latMin, latMax, simpleLayout, currentTime }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })

  const minLat = latMin ?? EAST_LAT_MIN
  const maxLat = latMax ?? LAT_MAX

  // 響應式尺寸
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setDimensions({ width: rect.width, height: rect.height })
      }
    }
    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [])

  // 繪製波型
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
      willReadFrequently: false
    })

    if (!ctx) return

    const { width, height } = dimensions

    let animationFrameId

    const draw = () => {
      // 清空畫布
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = '#0a0e27'
      ctx.fillRect(0, 0, width, height)

      // 繪製緯度參考線
      const drawLatitudeGrid = () => {
        if (simpleLayout) return

        ctx.strokeStyle = 'rgba(100, 181, 246, 0.15)'
        ctx.lineWidth = 1
        ctx.font = '11px monospace'
        ctx.fillStyle = '#64b5f6'

        for (let lat = Math.ceil(minLat); lat <= maxLat; lat += 0.5) {
          const y = ((maxLat - lat) / (maxLat - minLat)) * height

          if (lat % 1 === 0) {
            ctx.strokeStyle = 'rgba(100, 181, 246, 0.3)'
            ctx.setLineDash([])
          } else {
            ctx.strokeStyle = 'rgba(100, 181, 246, 0.15)'
            ctx.setLineDash([5, 5])
          }

          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(width, y)
          ctx.stroke()

          if (lat % 1 === 0) {
            ctx.fillStyle = '#64b5f6'
            ctx.fillText(`${lat}°N`, 8, y - 5)
          }
        }
        ctx.setLineDash([])
      }

      // 繪製時間軸（最右側是 0s，往左是過去）
      const drawTimeAxis = () => {
        const timeAxisY = height - 25
        const waveWidth = width * 0.75
        const xOffset = width * 0.15

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'
        ctx.lineWidth = 1
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.moveTo(xOffset, timeAxisY)
        ctx.lineTo(xOffset + waveWidth, timeAxisY)
        ctx.stroke()

        ctx.font = '10px monospace'
        ctx.fillStyle = '#90caf9'
        ctx.textAlign = 'center'

        // 時間刻度：0s, -10s, -20s, -30s, -40s, -50s, -60s（共 7 個刻度）
        const numTicks = 7
        for (let i = 0; i < numTicks; i++) {
          const timeValue = -i * (TIME_WINDOW / (numTicks - 1))
          const x = xOffset + waveWidth - (i / (numTicks - 1)) * waveWidth

          ctx.beginPath()
          ctx.moveTo(x, timeAxisY)
          ctx.lineTo(x, timeAxisY + 5)
          ctx.stroke()

          // 0s 位置顯示當前時間（HH:MM:SS），其他顯示相對時間
          let label
          if (timeValue === 0) {
            const now = new Date()
            const hours = String(now.getHours()).padStart(2, '0')
            const minutes = String(now.getMinutes()).padStart(2, '0')
            const seconds = String(now.getSeconds()).padStart(2, '0')
            label = `${hours}:${minutes}:${seconds}`
            ctx.fillStyle = '#4caf50' // 當前時間用綠色
          } else {
            label = `${timeValue.toFixed(0)}s`
            ctx.fillStyle = '#90caf9' // 過去時間用藍色
          }

          ctx.fillText(label, x, timeAxisY + 17)
        }

        ctx.textAlign = 'left'
      }

      drawLatitudeGrid()
      drawTimeAxis()

      // 繪製各測站波型
      const waveWidth = width * 0.75
      const waveHeight = simpleLayout ? 40 : 30
      const xOffset = width * 0.15

      stations.forEach((stationCode, index) => {
        const station = stationMap[stationCode]
        if (!station) return

        // 計算 Y 位置
        let centerY
        if (simpleLayout) {
          const stationSpacing = waveHeight * 1.0
          const topMargin = waveHeight * 1.0
          const totalStationsHeight = stationSpacing * (stations.length - 1)
          const bottomMargin = height - topMargin - totalStationsHeight
          const adjustedTopMargin = bottomMargin < waveHeight * 0.8 ? topMargin * 0.8 : topMargin
          centerY = adjustedTopMargin + stationSpacing * index
        } else {
          if (!station.latitude) return
          centerY = ((maxLat - station.latitude) / (maxLat - minLat)) * height
        }

        const waveData = waveDataMap[stationCode]

        // 繪製測站基線
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'
        ctx.lineWidth = 0.5
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(xOffset, centerY)
        ctx.lineTo(xOffset + waveWidth, centerY)
        ctx.stroke()
        ctx.setLineDash([])

        // 繪製測站標籤
        ctx.fillStyle = waveData ? '#e0e0e0' : '#666'
        ctx.font = '10px monospace'
        ctx.textAlign = 'right'
        ctx.fillText(stationCode, xOffset - 8, centerY + 3)

        // 繪製測站資訊
        ctx.textAlign = 'left'
        ctx.font = '9px sans-serif'
        if (station.station_zh) {
          ctx.fillText(station.station_zh, xOffset + waveWidth + 5, centerY - 8)
        }
        if (waveData?.lastPga) {
          ctx.fillStyle = '#4caf50'
          ctx.fillText(`PGA: ${waveData.lastPga.toFixed(2)}`, xOffset + waveWidth + 5, centerY + 2)
        }
        // 顯示動態縮放範圍（用於調試）
        if (waveData?.displayScale) {
          ctx.fillStyle = '#90caf9'
          ctx.font = '8px monospace'
          ctx.fillText(`±${waveData.displayScale.toFixed(2)}`, xOffset + waveWidth + 5, centerY + 11)
        }

        // 繪製波型（每個數據包內部連線，數據包之間不連線）
        if (!waveData || !waveData.dataPoints || waveData.dataPoints.length === 0) return

        const dataPoints = waveData.dataPoints
        const displayScale = waveData.displayScale || 1.0 // 動態縮放因子

        ctx.strokeStyle = '#4caf50'
        ctx.lineWidth = 5.2
        ctx.globalAlpha = 0.9

        // 遍歷每個數據包，在包內部連線
        dataPoints.forEach(point => {
          const { timestamp, values } = point

          // 計算這個數據點距離當前時間的差值（毫秒）
          const timeDiff = currentTime - timestamp

          // 如果超過時間窗口，跳過
          if (timeDiff < 0 || timeDiff > TIME_WINDOW * 1000) return

          // 計算這個數據點在時間軸上的起始位置（秒）
          const startTimeOffset = timeDiff / 1000 // 轉換為秒

          // 開始新的路徑（每個數據包獨立）
          ctx.beginPath()
          let hasFirstPoint = false

          // 繪製這個數據點的所有採樣值（100 個點 = 1 秒）
          values.forEach((value, idx) => {
            // 計算這個採樣點的時間偏移（秒）
            const sampleTimeOffset = startTimeOffset - (idx / SAMPLE_RATE)

            // 如果超出範圍，跳過
            if (sampleTimeOffset < 0 || sampleTimeOffset > TIME_WINDOW) return

            // 計算 x 位置：最右側是 0s（當前），往左是過去
            const x = xOffset + waveWidth * (1 - sampleTimeOffset / TIME_WINDOW)

            // 使用動態縮放因子 normalize 數據
            const normalizedValue = value / displayScale

            // 限制在 ±1 範圍內，避免極端值爆格
            const clampedValue = Math.max(-1, Math.min(1, normalizedValue))

            // 計算 y 位置（正規化到 ±waveHeight/2）
            const y = centerY - clampedValue * (waveHeight / 2)

            if (!hasFirstPoint) {
              ctx.moveTo(x, y)
              hasFirstPoint = true
            } else {
              ctx.lineTo(x, y)
            }
          })

          // 繪製這個數據包的路徑
          ctx.stroke()
        })

        ctx.globalAlpha = 1
      })
    }

    animationFrameId = requestAnimationFrame(draw)

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId)
      }
    }
  }, [stations, stationMap, waveDataMap, dimensions, minLat, maxLat, simpleLayout, currentTime])

  return (
    <div ref={containerRef} className="geographic-wave-panel">
      <div className="panel-header">
        <h3>{title}</h3>
        <span className="station-count">{stations.length} 站</span>
      </div>
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  )
}

GeographicWavePanel.propTypes = {
  title: PropTypes.string.isRequired,
  stations: PropTypes.array.isRequired,
  stationMap: PropTypes.object.isRequired,
  waveDataMap: PropTypes.object.isRequired,
  latMin: PropTypes.number,
  latMax: PropTypes.number,
  simpleLayout: PropTypes.bool,
  currentTime: PropTypes.number.isRequired
}

function RealtimeWaveform({ targetStations, wavePackets }) {
  const [stationMap, setStationMap] = useState({})
  const [waveDataMap, setWaveDataMap] = useState({})
  const [westLatRange, setWestLatRange] = useState({ min: EAST_LAT_MIN, max: LAT_MAX })
  const leftColumnRef = useRef(null)
  const [currentTime, setCurrentTime] = useState(Date.now())

  // 建立測站快速查找 Map
  useEffect(() => {
    const map = {}
    targetStations.forEach(station => {
      map[station.station] = station
    })
    setStationMap(map)
  }, [targetStations])

  // 初始化所有測站的數據結構
  useEffect(() => {
    if (targetStations.length === 0) return

    setWaveDataMap(prev => {
      const updated = { ...prev }
      targetStations.forEach(station => {
        if (!updated[station.station]) {
          updated[station.station] = {
            dataPoints: [], // 數據點列表：[{timestamp, values}, ...]
            lastPga: 0
          }
        }
      })
      return updated
    })
  }, [targetStations])

  // 更新當前時間（每 100ms 更新一次，用於重繪波形）
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now())
    }, 100)
    return () => clearInterval(interval)
  }, [])

  // 處理新的波形數據
  useEffect(() => {
    if (wavePackets.length === 0) return

    const latestPacket = wavePackets[0]
    const packetTimestamp = latestPacket.timestamp || Date.now()

    console.log('📊 Processing wave packet:', {
      waveid: latestPacket.waveid,
      timestamp: packetTimestamp,
      dataKeys: latestPacket.data ? Object.keys(latestPacket.data) : []
    })

    setWaveDataMap(prev => {
      const updated = { ...prev }

      if (latestPacket.data) {
        Object.keys(latestPacket.data).forEach(seedStation => {
          // 從 SEED 格式提取測站代碼（SM.F028.01.HLZ -> F028）
          const stationCode = extractStationCode(seedStation)

          console.log(`🔄 Processing station: ${seedStation} -> ${stationCode}`)

          if (!updated[stationCode]) {
            updated[stationCode] = {
              dataPoints: [],
              lastPga: 0
            }
            console.log(`✨ Created new station data for: ${stationCode}`)
          }

          const stationData = updated[stationCode]
          const waveform = latestPacket.data[seedStation]?.waveform || []
          const pga = latestPacket.data[seedStation]?.pga || 0

          console.log(`📈 Waveform data: ${waveform.length} points, PGA: ${pga.toFixed(2)}`)

          // 添加新的數據點（帶時間戳）
          stationData.dataPoints.push({
            timestamp: packetTimestamp,
            values: waveform
          })

          // 清理超過時間窗口的舊數據（保留 60 秒內的數據）
          const cutoffTime = Date.now() - TIME_WINDOW * 1000
          stationData.dataPoints = stationData.dataPoints.filter(
            point => point.timestamp >= cutoffTime
          )

          stationData.lastPga = pga

          // 計算動態縮放範圍（用於 normalize 顯示）
          // 使用最近 10 秒的數據計算 RMS 和 最大振幅
          const recentCutoff = Date.now() - 10 * 1000 // 最近 10 秒
          const recentPoints = stationData.dataPoints.filter(
            point => point.timestamp >= recentCutoff
          )

          if (recentPoints.length > 0) {
            let sumSquares = 0
            let maxAbs = 0
            let count = 0

            recentPoints.forEach(point => {
              point.values.forEach(value => {
                sumSquares += value * value
                maxAbs = Math.max(maxAbs, Math.abs(value))
                count++
              })
            })

            const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0.1

            // 動態縮放因子：背景雜訊時放大，大振幅時壓縮
            // 使用 RMS*8 讓背景雜訊更明顯，但大振幅時壓縮避免爆格
            const baseScale = Math.max(rms * 8, maxAbs * 0.6, 0.05) // 至少顯示 ±0.05
            stationData.displayScale = baseScale
            stationData.rms = rms
            stationData.maxAbs = maxAbs

            // 調試輸出（每 5 秒輸出一次，只顯示前 3 個測站）
            if (!window._lastScaleLog || Date.now() - window._lastScaleLog > 5000) {
              const debugStations = Object.keys(updated).slice(0, 3)
              if (debugStations.includes(stationCode)) {
                console.log(`📊 ${stationCode}: RMS=${rms.toFixed(3)}, Max=${maxAbs.toFixed(3)}, Scale=${baseScale.toFixed(3)}`)
              }
              if (debugStations.indexOf(stationCode) === debugStations.length - 1) {
                window._lastScaleLog = Date.now()
              }
            }
          } else {
            stationData.displayScale = 1.0
            stationData.rms = 0
            stationData.maxAbs = 0
          }
        })
      }

      console.log('📍 Updated waveDataMap stations:', Object.keys(updated))
      return updated
    })
  }, [wavePackets])

  // 計算西部面板的緯度範圍
  useEffect(() => {
    const calculateWestLatRange = () => {
      if (!leftColumnRef.current) return

      const leftColumnHeight = leftColumnRef.current.clientHeight
      const westPanelHeight = leftColumnHeight - ISLANDS_PANEL_HEIGHT - PANEL_GAP
      const eastPanelHeight = leftColumnHeight
      const eastLatRange = LAT_MAX - EAST_LAT_MIN
      const westLatRange = eastLatRange * (westPanelHeight / eastPanelHeight)
      const westLatMin = LAT_MAX - westLatRange

      setWestLatRange({ min: westLatMin, max: LAT_MAX })
    }

    calculateWestLatRange()
    window.addEventListener('resize', calculateWestLatRange)

    const resizeObserver = new ResizeObserver(calculateWestLatRange)
    if (leftColumnRef.current) {
      resizeObserver.observe(leftColumnRef.current)
    }

    return () => {
      window.removeEventListener('resize', calculateWestLatRange)
      resizeObserver.disconnect()
    }
  }, [])

  return (
    <div className="realtime-waveform geographic">
      <div className="waveform-grid geographic-grid">
        <div ref={leftColumnRef} className="left-column">
          <GeographicWavePanel
            title={STATION_GROUPS.west.title}
            stations={STATION_GROUPS.west.stations}
            stationMap={stationMap}
            waveDataMap={waveDataMap}
            latMin={westLatRange.min}
            latMax={westLatRange.max}
            currentTime={currentTime}
          />
          <GeographicWavePanel
            title={STATION_GROUPS.islands.title}
            stations={STATION_GROUPS.islands.stations}
            stationMap={stationMap}
            waveDataMap={waveDataMap}
            simpleLayout={true}
            currentTime={currentTime}
          />
        </div>

        <div className="right-column">
          <GeographicWavePanel
            title={STATION_GROUPS.east.title}
            stations={STATION_GROUPS.east.stations}
            stationMap={stationMap}
            waveDataMap={waveDataMap}
            latMin={EAST_LAT_MIN}
            latMax={EAST_LAT_MAX}
            currentTime={currentTime}
          />
          <GeographicWavePanel
            title={STATION_GROUPS.test_group.title}
            stations={STATION_GROUPS.test_group.stations}
            stationMap={stationMap}
            waveDataMap={waveDataMap}
            simpleLayout={true}
            currentTime={currentTime}
          />
        </div>
      </div>
    </div>
  )
}

RealtimeWaveform.propTypes = {
  targetStations: PropTypes.array.isRequired,
  wavePackets: PropTypes.array.isRequired
}

export default RealtimeWaveform

