# Runs in ReportsFunction on a timer. The template points at `handler`,
# which is a second name for the function that does the work.


def run_nightly(event, context):
    return {"generated": event.get("time", "unknown")}


handler = run_nightly
