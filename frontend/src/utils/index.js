// Utility: getIntensityValue
// 將震度字串轉換為可比較數值（與原 ReportDetail.jsx 中相同邏輯）
export const getIntensityValue = (intensityStr) => {
  if (!intensityStr || intensityStr === 'N/A') return -1;
  const val = parseInt(intensityStr, 10);
  if (isNaN(val)) return -1;
  if (intensityStr.includes('+')) return val + 0.5;
  if (intensityStr.includes('-')) return val - 0.5;
  return val;
};

