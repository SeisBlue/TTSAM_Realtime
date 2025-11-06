import React from 'react'

export default function DatasetDetail({ dataset }) {
  if (!dataset) return null

  return (
    <div className="detail-container">
      <div className="detail-header">
        <h2>📊 預測資料集詳細</h2>
        <span className="detail-timestamp">{dataset.timestamp}</span>
      </div>

      <div className="detail-section">
        <h3>模型資訊</h3>
        <div className="detail-grid">
          <div className="detail-item">
            <span className="detail-label">模型類型</span>
            <span className="detail-value">{dataset.model_type}</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">來源測站數</span>
            <span className="detail-value">{dataset.source_stations?.length || 0} 個</span>
          </div>
          <div className="detail-item">
            <span className="detail-label">目標測站數</span>
            <span className="detail-value">{dataset.target_names?.length || 0} 個</span>
          </div>
        </div>
      </div>

      <div className="detail-section">
        <h3>來源測站</h3>
        <div className="station-grid">
          {dataset.source_stations?.map((station, idx) => (
            <div key={idx} className="station-badge source">
              {station}
            </div>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <h3>目標測站</h3>
        <div className="station-grid">
          {dataset.target_names?.slice(0, 20).map((station, idx) => (
            <div key={idx} className="station-badge target">
              {station}
            </div>
          ))}
          {dataset.target_names?.length > 20 && (
            <div className="station-badge more">
              +{dataset.target_names.length - 20} 個測站
            </div>
          )}
        </div>
      </div>

      <div className="detail-section">
        <h3>原始資料</h3>
        <pre className="detail-json">
          {JSON.stringify(dataset, null, 2)}
        </pre>
      </div>
    </div>
  )
}

