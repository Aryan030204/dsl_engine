const SCHEDULE_WINDOW_MODES = {
  PREVIOUS_COMPLETE_DAY: 'previous_complete_day',
  DAY_TO_DATE_VS_PREVIOUS_DAY: 'day_to_date_vs_previous_day',
  DAY_TO_DATE_VS_7DAY_AVERAGE: 'day_to_date_vs_7day_average'
};

const SCHEDULE_WINDOW_MODE_VALUES = Object.values(SCHEDULE_WINDOW_MODES);

module.exports = {
  SCHEDULE_WINDOW_MODES,
  SCHEDULE_WINDOW_MODE_VALUES,
};
