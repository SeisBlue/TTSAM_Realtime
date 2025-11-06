import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import './RealtimeWaveform.css'

// 四象限分區定義（基於緯度 24.0° 和經度 121.0° 分界）
// 分析 eew_target.csv 後的實際地理分布
const QUADRANT_CONFIG = {
  northwest: {
    title: '西北部 (緯>24°, 經<121°)',
    stations: [
      // 緯度 25°+ (北部)
      'NTS', 'NOU', 'TAP', 'A024', 'TIPB',
      // 緯度 24.7-25°
      'NTY', 'NCU', 'B011',
      // 緯度 24.3-24.7
      'HSN1', 'HSN', 'NJD', 'B131', 'TWQ1',
      // 緯度 24.0-24.3
      'B045', 'WDJ'
    ] // 15 站
  },
  northeast: {
    title: '東北部 (緯>24°, 經>121°)',
    stations: [
      // 緯度 24.6-24.9 (宜蘭區)
      'ILA', 'TIPB', 'TWC', 'ENT',
      // 緯度 24.0-24.3 (花蓮北)
      'WHP', 'WPL'
    ] // 6 站
  },
  southwest: {
    title: '西南部 (緯<24°, 經<121°)',
    stations: [
      // 緯度 23.7-24.0 (中部)
      'TCU', 'WNT1', 'WCHH', 'WYL',
      // 緯度 23.4-23.7 (南投/雲林/嘉義)
      'WHY', 'WDL', 'WSL', 'CHY1', 'C095', 'WCKO', 'C015',
      // 緯度 22.7-23.3 (台南/高雄)
      'TAI', 'CHN1', 'SCS', 'KAU', 'SPT', 'SSD',
      // 緯度 22.0-22.7 (屏東)
      'HEN',
      // 離島
      'PNG', 'KNM', 'MSU'
    ] // 21 站
  },
  southeast: {
    title: '東南部 (緯<24°, 經>121°)',
    stations: [
      // 緯度 23.3-24.0 (花蓮)
      'HWA', 'EGFH',
      // 緯度 22.7-23.3 (花東縱谷)
      'EYUL', 'ECS',
      // 緯度 22.0-22.7 (台東)
      'TTN', 'TAWH'
    ] // 6 站
  }
}

function WaveformItem({ station, stationInfo, waveData }) {
  const getStatusClass = () => {
    if (!waveData) return 'status-waiting'
    const timeDiff = Date.now() - waveData.timestamp
    if (timeDiff < 3000) return 'status-active' // 3 秒內為活躍
    if (timeDiff < 10000) return 'status-recent' // 10 秒內為最近
    return 'status-stale' // 超過 10 秒為過時
  }

  const getPGA = () => {
    if (!waveData?.pga) return '--'
    return waveData.pga.toFixed(2)
  }

  return (
    <div className={`waveform-item ${getStatusClass()}`}>
      <div className="waveform-header">
        <span className="station-code">{station}</span>
        <span className="station-name">{stationInfo?.station_zh || '---'}</span>
      </div>
      <div className="waveform-body">
        <div className="waveform-placeholder">
          {/* TODO: 實際波形圖（使用 Canvas 或 Chart.js） */}
          <div className="wave-line"></div>
        </div>
      </div>
      <div className="waveform-footer">
        <span className="pga-value">PGA: {getPGA()}</span>
        <span className="wave-indicator">
          {waveData ? '🌊' : '⏳'}
        </span>
      </div>
    </div>
  )
}

WaveformItem.propTypes = {
  station: PropTypes.string.isRequired,
  stationInfo: PropTypes.object,
  waveData: PropTypes.object
}

function QuadrantPanel({ title, stations, stationMap, waveDataMap }) {
  return (
    <div className="quadrant-panel">
      <div className="quadrant-header">
        <h3>{title}</h3>
        <span className="station-count">{stations.length} 站</span>
      </div>
      <div className="quadrant-content">
        {stations.map(station => (
          <WaveformItem
            key={station}
            station={station}
            stationInfo={stationMap[station]}
            waveData={waveDataMap[station]}
          />
        ))}
      </div>
    </div>
  )
}

QuadrantPanel.propTypes = {
  title: PropTypes.string.isRequired,
  stations: PropTypes.array.isRequired,
  stationMap: PropTypes.object.isRequired,
  waveDataMap: PropTypes.object.isRequired
}

function RealtimeWaveform({ targetStations, wavePackets }) {
  const [stationMap, setStationMap] = useState({})
  const [waveDataMap, setWaveDataMap] = useState({})

  // 建立測站快速查找 Map
  useEffect(() => {
    const map = {}
    targetStations.forEach(station => {
      map[station.station] = station
    })
    setStationMap(map)
  }, [targetStations])

  // 更新波形資料 Map
  useEffect(() => {
    if (wavePackets.length === 0) return

    const latestPacket = wavePackets[0]
    const newWaveDataMap = {}

    // 從最新的 wave_packet 中提取各測站資料
    // 假設 wave_packet 結構包含各測站的波形資料
    if (latestPacket.data) {
      Object.keys(latestPacket.data).forEach(station => {
        newWaveDataMap[station] = {
          timestamp: Date.now(),
          pga: latestPacket.data[station]?.pga || 0,
          waveform: latestPacket.data[station]?.waveform || []
        }
      })
    }

    setWaveDataMap(prev => ({...prev, ...newWaveDataMap}))
  }, [wavePackets])

  return (
    <div className="realtime-waveform">
      <div className="waveform-grid">
        <QuadrantPanel
          title={QUADRANT_CONFIG.northwest.title}
          stations={QUADRANT_CONFIG.northwest.stations}
          stationMap={stationMap}
          waveDataMap={waveDataMap}
        />
        <QuadrantPanel
          title={QUADRANT_CONFIG.northeast.title}
          stations={QUADRANT_CONFIG.northeast.stations}
          stationMap={stationMap}
          waveDataMap={waveDataMap}
        />
        <QuadrantPanel
          title={QUADRANT_CONFIG.southwest.title}
          stations={QUADRANT_CONFIG.southwest.stations}
          stationMap={stationMap}
          waveDataMap={waveDataMap}
        />
        <QuadrantPanel
          title={QUADRANT_CONFIG.southeast.title}
          stations={QUADRANT_CONFIG.southeast.stations}
          stationMap={stationMap}
          waveDataMap={waveDataMap}
        />
      </div>
    </div>
  )
}

RealtimeWaveform.propTypes = {
  targetStations: PropTypes.array.isRequired,
  wavePackets: PropTypes.array.isRequired
}

export default RealtimeWaveform

