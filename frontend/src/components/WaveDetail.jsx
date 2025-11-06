import React from 'react'
import WaveCanvas from './WaveCanvas'

export default function WaveDetail({ wave }) {
  if (!wave) return null

  return (
    <div className="detail-container">
      <div className="detail-header">
        <h2>🌊 波形資料詳細</h2>
        <span className="detail-id">{wave.waveid}</span>
      </div>

      <div className="detail-section">
        <h3>波形資訊</h3>
        <div className="detail-grid">
          <div className="detail-item">
            <span className="detail-label">Wave ID</span>
            <span className="detail-value">{wave.waveid}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">資料點數</span>
            <span className="detail-value">{wave.data.length} 點</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>波形預覽</h3>
        <div className="wave-canvas-container">
          <WaveCanvas data={wave.data} width={800} height={200} />
        </div>
      </div>

      <div className="detail-section">
        <h3>統計資訊</h3>
        <div className="detail-grid">
          <div className="detail-item">
            <span className="detail-label">最大值</span>
            <span className="detail-value">{Math.max(...wave.data).toFixed(2)}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">最小值</span>
            <span className="detail-value">{Math.min(...wave.data).toFixed(2)}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">平均值</span>
            <span className="detail-value">
              {(wave.data.reduce((a, b) => a + b, 0) / wave.data.length).toFixed(2)}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

