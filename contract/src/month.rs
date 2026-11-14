// Calendar months (UTC) for the Employee of the Month counters.
use crate::{DAY_MS, DeskRecord};

/// `year * 100 + month` in UTC of a unix time in milliseconds, with integer civil-from-days
/// arithmetic (Howard Hinnant's algorithm; the day count is never negative here).
pub fn month_of(ms: u64) -> u32 {
    let z = ms / DAY_MS + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + u64::from(m <= 2);
    (y * 100 + m) as u32
}

/// Applies one event that happened in `event_month` to the desk's month counters. A newer month
/// starts them over; an older one (a miss settled late) only changes the lifetime counters,
/// which the caller updates.
pub fn count_month(desk: &mut DeskRecord, event_month: u32, on_time: u32, missed: u32, burned: u128) {
    if event_month > desk.month {
        desk.month = event_month;
        desk.month_on_time = 0;
        desk.month_missed = 0;
        desk.month_burned = 0;
    }
    if event_month == desk.month {
        desk.month_on_time += on_time;
        desk.month_missed += missed;
        desk.month_burned += burned;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_of_known_dates() {
        assert_eq!(month_of(0), 197001); // 1970-01-01
        assert_eq!(month_of(951_782_400_000), 200002); // 2000-02-29
        assert_eq!(month_of(1_709_164_800_000), 202402); // 2024-02-29
        assert_eq!(month_of(1_794_614_400_000), 202611); // 2026-11-14
        assert_eq!(month_of(1_796_083_200_000 - 1), 202611); // 2026-11-30T23:59:59.999Z
        assert_eq!(month_of(1_796_083_200_000), 202612); // 2026-12-01T00:00:00Z
        assert_eq!(month_of(1_798_761_600_000), 202701); // 2027-01-01
        assert_eq!(month_of(1_798_761_600_000 - 1), 202612);
    }

    #[test]
    fn a_new_month_starts_over_and_an_old_one_changes_nothing() {
        let mut d = DeskRecord::default();
        count_month(&mut d, 202611, 1, 0, 0);
        count_month(&mut d, 202611, 0, 1, 7);
        assert_eq!((d.month, d.month_on_time, d.month_missed, d.month_burned), (202611, 1, 1, 7));
        count_month(&mut d, 202612, 1, 0, 0);
        assert_eq!((d.month, d.month_on_time, d.month_missed, d.month_burned), (202612, 1, 0, 0));
        count_month(&mut d, 202611, 0, 1, 9);
        assert_eq!((d.month, d.month_on_time, d.month_missed, d.month_burned), (202612, 1, 0, 0));
    }
}
