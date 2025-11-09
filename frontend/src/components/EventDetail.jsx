import React from 'react'
import PropTypes from 'prop-types'

export default function EventDetail({ event, onBack }) {
  if (!event) return null

  return (
    <div className="detail-container">
      <div className="detail-header">
        <div className="detail-header-left">
          <h2>📍 觸發事件詳細資訊</h2>
          <span className="detail-timestamp">{event.timestamp}</span>
        </div>
        <button className="back-button" onClick={onBack}>
          ← 回上頁
        </button>
      </div>

      <div className="detail-section">
        <h3>測站資訊</h3>
        <div className="detail-grid">
          <div className="detail-item">
            <span className="detail-label">測站數量</span>
            <span className="detail-value">{event.stations.length} 個</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>測站列表</h3>
        <div className="station-grid">
          {event.stations.map((station, idx) => (
            <div key={idx} className="station-badge">
              {station}
            </div>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <h3>原始資料</h3>
        <pre className="detail-json">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      </div>
    </div>
  )
}

EventDetail.propTypes = {
  event: PropTypes.object,
  onBack: PropTypes.func.isRequired
}

