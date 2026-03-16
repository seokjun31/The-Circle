/**
 * Credit cost constants — kept in sync with the backend service constants.
 * Import these to display credit cost labels on action buttons.
 */
export const CREDIT_COSTS = {
  CIRCLE_AI:         2,   // Circle.ai 스타일 변환
  MATERIAL_APPLY:    1,   // 자재 적용 (영역당)
  MOOD_COPY:         3,   // 분위기 Copy
  FURNITURE_PLACE:   1,   // 가구 배치 (AI 합성)
  FINAL_RENDER_STD:  3,   // 최종 렌더링 (표준)
  FINAL_RENDER_HIGH: 5,   // 최종 렌더링 (고품질)
};

/**
 * Helper to format a credit cost label for action buttons.
 * Example: creditLabel(CREDIT_COSTS.CIRCLE_AI) → "(2크레딧)"
 */
export function creditLabel(cost) {
  return `(${cost}크레딧)`;
}
