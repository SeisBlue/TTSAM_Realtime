import { useState, useEffect } from 'react'
import io from 'socket.io-client'
import './App.css'

function App() {
  const [isConnected, setIsConnected] = useState(false)
  const [events, setEvents] = useState([])
  const [wavePackets, setWavePackets] = useState([])
  const [datasets, setDatasets] = useState([])

  useEffect(() => {
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

    // 接收預測資料集
    socket.on('dataset', (data) => {
      console.log('📊 Dataset received:', data.source_stations)
      setDatasets(prev => [data, ...prev].slice(0, 10)) // 保留最新 10 筆
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
        {/* 地震事件列表 */}
        <section className="section events-section">
          <h2>📍 地震事件 ({events.length})</h2>
          <div className="event-list">
            {events.length === 0 ? (
              <p className="empty-message">等待地震事件資料...</p>
            ) : (
              events.map(event => (
                <div key={event.id} className="event-card">
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
                <div key={idx} className="wave-card">
                  <span className="wave-id">{wave.waveid}</span>
                  <span className="wave-points">{wave.data.length} 點</span>
                </div>
              ))
            )}
          </div>
        </section>

        {/* 預測資料集列表 */}
        <section className="section datasets-section">
          <h2>📊 預測資料集 ({datasets.length})</h2>
          <div className="dataset-list">
            {datasets.length === 0 ? (
              <p className="empty-message">等待預測資料...</p>
            ) : (
              datasets.map((dataset, idx) => (
                <div key={idx} className="dataset-card">
                  <div className="dataset-header">
                    <span className="dataset-time">{dataset.timestamp}</span>
                    <span className="dataset-type">{dataset.model_type}</span>
                  </div>
                  <div className="dataset-info">
                    <span>來源: {dataset.source_stations?.join(', ')}</span>
                    <span>目標: {dataset.target_names?.length || 0} 個測站</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

export default App
