import { useState, useEffect } from 'react'
import io from 'socket.io-client'
import './App.css'
import EventDetail from './components/EventDetail'
import WaveDetail from './components/WaveDetail'
import TaiwanMap from './components/TaiwanMap'

function App() {
  const [isConnected, setIsConnected] = useState(false)
  const [events, setEvents] = useState([])
  const [wavePackets, setWavePackets] = useState([])
  const [targetStations, setTargetStations] = useState([]) // eew_target 測站列表

  // 右側詳細頁面狀態
  const [selectedType, setSelectedType] = useState(null) // 'event' | 'wave' | 'dataset'
  const [selectedItem, setSelectedItem] = useState(null)

  useEffect(() => {
    // 載入 eew_target 測站資料
    fetch('/data/eew_target.csv')
      .then(res => res.text())
      .then(text => {
        const lines = text.split('\n').slice(1) // 跳過 header
        const stations = lines
          .filter(line => line.trim())
          .map(line => {
            const [network, county, station, station_zh, longitude, latitude, elevation] = line.split(',')
            return {
              network,
              county,
              station,
              station_zh,
              longitude: parseFloat(longitude),
              latitude: parseFloat(latitude),
              elevation: parseFloat(elevation),
              status: 'unknown', // unknown, online, warning, offline
              lastSeen: null,
              pga: null
            }
          })
        setTargetStations(stations)
        console.log('📍 Loaded', stations.length, 'target stations')
      })
      .catch(err => console.error('載入測站資料失敗:', err))

    // 連接到 Mock Server 的 SocketIO
    const socket = io('http://localhost:5001', {
      transports: ['websocket', 'polling']
    })

    // 連線事件
    socket.on('connect', () => {
      console.log('✅ Connected to Mock Server')
      setIsConnected(true)
    })

    socket.on('disconnect', () => {
      console.log('❌ Disconnected from Mock Server')
      setIsConnected(false)
    })

    socket.on('connect_init', () => {
      console.log('🔌 Connection initialized')
    })

    // 接收波形資料
    socket.on('wave_packet', (data) => {
      console.log('🌊 Wave packet received:', data.waveid)
      setWavePackets(prev => [data, ...prev].slice(0, 10)) // 保留最新 10 筆
    })

    // 接收地震事件
    socket.on('event_data', (data) => {
      console.log('📍 Event data received:', Object.keys(data).length, 'stations')
      const timestamp = new Date().toLocaleString('zh-TW')
      setEvents(prev => [{
        id: Date.now(),
        timestamp,
        stations: Object.keys(data),
        data
      }, ...prev].slice(0, 20)) // 保留最新 20 筆
    })


    // 清理函式
    return () => {
      socket.disconnect()
    }
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <h1>🌏 TTSAM 地震預警即時監控</h1>
        <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
          {isConnected ? '🟢 已連接 Mock Server' : '🔴 未連接'}
        </div>
      </header>

      <div className="dashboard">
        {/* 左側面板：即時更新列表 */}
        <div className="left-panel">
          {/* 地震事件列表 */}
          <section className="section events-section">
            <h2>📍 地震事件 ({events.length})</h2>
            <div className="event-list">
              {events.length === 0 ? (
                <p className="empty-message">等待地震事件資料...</p>
              ) : (
                events.map(event => (
                  <div
                    key={event.id}
                    className={`event-card ${selectedType === 'event' && selectedItem?.id === event.id ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedType('event')
                      setSelectedItem(event)
                    }}
                  >
                    <div className="event-header">
                      <span className="event-time">{event.timestamp}</span>
                      <span className="event-stations">{event.stations.length} 個測站</span>
                    </div>
                    <div className="event-stations-list">
                      {event.stations.slice(0, 5).map((station, idx) => (
                        <span key={idx} className="station-tag">{station}</span>
                      ))}
                      {event.stations.length > 5 && (
                        <span className="station-tag more">+{event.stations.length - 5}</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* 波形資料列表 */}
          <section className="section waves-section">
            <h2>🌊 波形資料 ({wavePackets.length})</h2>
            <div className="wave-list">
              {wavePackets.length === 0 ? (
                <p className="empty-message">等待波形資料...</p>
              ) : (
                wavePackets.map((wave, idx) => (
                  <div
                    key={idx}
                    className={`wave-card ${selectedType === 'wave' && selectedItem?.waveid === wave.waveid ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedType('wave')
                      setSelectedItem(wave)
                    }}
                  >
                    <span className="wave-id">{wave.waveid}</span>
                    <span className="wave-points">{wave.data.length} 點</span>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* 台灣地圖 - 顯示 target 測站 */}
          <section className="section map-section">
            <h2>🗺️ 測站分布</h2>
            <TaiwanMap stations={targetStations} />
          </section>
        </div>

        {/* 右側面板：詳細內容 */}
        <div className="right-panel">
          {!selectedType ? (
            <div className="right-panel-placeholder">
              <div className="right-panel-placeholder-icon">👈</div>
              <div>點擊左側項目查看詳細資訊</div>
            </div>
          ) : (
            <>
              {selectedType === 'event' && <EventDetail event={selectedItem} />}
              {selectedType === 'wave' && <WaveDetail wave={selectedItem} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default App
