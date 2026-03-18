#!/bin/bash
set -euo pipefail

# summarize-audit.sh — Produce per-agent compliance reports from agent-audit-log.jsonl
#
# Usage: summarize-audit.sh <audit-log-path> <output-dir>
#
# Reads the JSONL audit log and produces:
#   <output-dir>/compliance-report.json — per-agent compliance checks
#
# Compliance checks performed:
#
# test-writer-v2:
#   - Did it read any rules/*.md files?
#   - Did it read the analysis JSON?
#   - Did it read the source file?
#   - Did it write a test file?
#
# test-analyzer:
#   - Did it read the source file?
#   - Did it grep for analytics action strings?
#   - Did it invoke boundary-finder-v2 (for hook-with-mutations)?
#   - Did it search for sibling test files?
#   - Did it write the analysis JSON?
#
# test-validator:
#   - Did it run validate-test.sh?
#   - Did it run validate-test-custom.sh?
#   - Did it run vitest / test:unit?
#   - Did it run snapshot update (-u)?
#   - Did it run lint?
#   - Did it run type-check?

AUDIT_LOG="${1:?Usage: summarize-audit.sh <audit-log-path> <output-dir>}"
OUTPUT_DIR="${2:?Usage: summarize-audit.sh <audit-log-path> <output-dir>}"

if [[ ! -f "${AUDIT_LOG}" ]]; then
  echo '{"error": "Audit log not found"}' >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"

python3 -c "
import json
import sys
from collections import defaultdict

audit_log = '${AUDIT_LOG}'
output_dir = '${OUTPUT_DIR}'

# Parse all events
events = []
with open(audit_log) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue

# Group events by session
sessions = defaultdict(list)
for e in events:
    sessions[e.get('sessionID', 'unknown')].append(e)

# Map session -> agent
session_agents = {}
for sid, evts in sessions.items():
    for e in evts:
        if e.get('type') == 'session_start':
            session_agents[sid] = e.get('agent', 'unknown')
            break
    if sid not in session_agents:
        # Fallback: use first event's agent
        session_agents[sid] = evts[0].get('agent', 'unknown') if evts else 'unknown'

# --- Compliance checks per agent type ---

def check_writer(session_events):
    \"\"\"Check test-writer-v2 compliance.\"\"\"
    checks = {
        'read_rules': False,
        'rules_read': [],
        'read_analysis_json': False,
        'read_source_file': False,
        'wrote_test_file': False,
        'model_text_mentions_rules': False,
        'model_text_mentions_analysis': False,
    }

    for e in session_events:
        if e.get('type') != 'tool_call' and e.get('type') != 'tool_result' and e.get('type') != 'model_text':
            continue

        tool = e.get('tool', '')
        args = e.get('args', {})
        fp = args.get('filePath', '') or args.get('path', '') or ''

        # Check reads
        if e['type'] == 'tool_call' and tool == 'read':
            if 'explore-unit-test-best-practices/rules/' in fp:
                checks['read_rules'] = True
                fname = fp.split('/')[-1] if '/' in fp else fp
                checks['rules_read'].append(fname)
            if 'test-analysis' in fp and fp.endswith('.json'):
                checks['read_analysis_json'] = True
            if '/src/' in fp and not fp.endswith('.test.tsx') and not fp.endswith('.test.ts'):
                checks['read_source_file'] = True

        # Check writes
        if e['type'] == 'tool_call' and tool == 'write':
            if fp.endswith('.test.tsx') or fp.endswith('.test.ts'):
                checks['wrote_test_file'] = True

        # Check model text for evidence of rule/analysis awareness
        if e['type'] == 'model_text':
            text = (e.get('text', '') or '').lower()
            if 'rules/' in text or 'best-practice' in text or 'rule file' in text:
                checks['model_text_mentions_rules'] = True
            if 'analysis' in text and ('json' in text or 'testcases' in text or 'sideeffects' in text):
                checks['model_text_mentions_analysis'] = True

    return checks

def check_analyzer(session_events):
    \"\"\"Check test-analyzer compliance.\"\"\"
    checks = {
        'read_source_file': False,
        'grep_analytics': False,
        'invoked_boundary_finder': False,
        'searched_sibling_tests': False,
        'wrote_analysis_json': False,
        'searched_test_utils': False,
    }

    for e in session_events:
        if e.get('type') != 'tool_call':
            continue

        tool = e.get('tool', '')
        args = e.get('args', {})
        fp = args.get('filePath', '') or args.get('path', '') or ''
        cmd = args.get('command', '') or ''
        pattern = args.get('pattern', '') or ''

        if tool == 'read' and '/src/' in fp and not fp.endswith('.json'):
            checks['read_source_file'] = True

        if tool == 'grep' and ('action' in pattern.lower() or 'snowplow' in pattern.lower() or 'analytics' in pattern.lower()):
            checks['grep_analytics'] = True
        if tool == 'bash' and ('grep' in cmd) and ('action' in cmd.lower() or 'Action' in cmd):
            checks['grep_analytics'] = True

        if tool == 'task':
            prompt = args.get('prompt', '') or ''
            if 'boundary' in prompt.lower():
                checks['invoked_boundary_finder'] = True

        if tool in ('glob', 'grep', 'read') and '.test.' in fp:
            checks['searched_sibling_tests'] = True
        if tool == 'glob' and '.test.' in pattern:
            checks['searched_sibling_tests'] = True

        if tool == 'write' and 'test-analysis' in fp and fp.endswith('.json'):
            checks['wrote_analysis_json'] = True

        if tool in ('read', 'glob') and 'test-utils' in fp:
            checks['searched_test_utils'] = True

    return checks

def check_validator(session_events):
    \"\"\"Check test-validator compliance.\"\"\"
    checks = {
        'ran_validate_test': False,
        'ran_validate_test_custom': False,
        'ran_vitest': False,
        'ran_snapshot_update': False,
        'ran_lint': False,
        'ran_type_check': False,
    }

    for e in session_events:
        if e.get('type') != 'tool_call':
            continue

        tool = e.get('tool', '')
        args = e.get('args', {})
        cmd = args.get('command', '') or ''

        if tool == 'bash':
            if 'validate-test.sh' in cmd and 'custom' not in cmd:
                checks['ran_validate_test'] = True
            if 'validate-test-custom.sh' in cmd:
                checks['ran_validate_test_custom'] = True
            if 'test:unit' in cmd or 'vitest' in cmd:
                if '-u' in cmd:
                    checks['ran_snapshot_update'] = True
                else:
                    checks['ran_vitest'] = True
            if 'lint' in cmd:
                checks['ran_lint'] = True
            if 'type-check' in cmd:
                checks['ran_type_check'] = True

    return checks


# --- Produce report ---

report = {
    'sessions': {},
    'summary': {
        'test-writer-v2': {'total': 0, 'compliance': {}},
        'test-analyzer': {'total': 0, 'compliance': {}},
        'test-validator': {'total': 0, 'compliance': {}},
    }
}

check_fns = {
    'test-writer-v2': check_writer,
    'test-analyzer': check_analyzer,
    'test-validator': check_validator,
}

# Per-session checks
for sid, evts in sessions.items():
    agent = session_agents.get(sid, 'unknown')
    if agent not in check_fns:
        continue

    checks = check_fns[agent](evts)
    target = None
    for e in evts:
        t = e.get('target')
        if t:
            target = t
            break

    report['sessions'][sid] = {
        'agent': agent,
        'target': target,
        'eventCount': len(evts),
        'checks': checks,
    }

# Aggregate summary
for sid, data in report['sessions'].items():
    agent = data['agent']
    if agent not in report['summary']:
        continue
    report['summary'][agent]['total'] += 1

    for check_name, check_val in data['checks'].items():
        if isinstance(check_val, bool):
            if check_name not in report['summary'][agent]['compliance']:
                report['summary'][agent]['compliance'][check_name] = {'passed': 0, 'failed': 0}
            if check_val:
                report['summary'][agent]['compliance'][check_name]['passed'] += 1
            else:
                report['summary'][agent]['compliance'][check_name]['failed'] += 1

# Write report
output_path = f'{output_dir}/compliance-report.json'
with open(output_path, 'w') as f:
    json.dump(report, f, indent=2)

print(f'Compliance report written to {output_path}')

# Print summary to stdout
print()
for agent, data in report['summary'].items():
    if data['total'] == 0:
        continue
    print(f'{agent} ({data[\"total\"]} sessions):')
    for check, counts in sorted(data['compliance'].items()):
        total = counts['passed'] + counts['failed']
        pct = (counts['passed'] / total * 100) if total > 0 else 0
        status = '✓' if pct == 100 else '✗' if pct == 0 else '~'
        print(f'  {status} {check}: {counts[\"passed\"]}/{total} ({pct:.0f}%)')
    print()
"
