import argparse
import json
import os
import re
import subprocess
import sys

DEFAULT_REPO = "microsoft/vscode-pull-request-github"
COPILOT_LOGINS = {"copilot-pull-request-reviewer"}
OVERVIEW_MARKER = "<!-- ccr-overview"

OPEN_RE = re.compile(r'(?P<count>\d+|No) open (?:issue|finding)s?\b', re.IGNORECASE)
RESOLVED_RE = re.compile(r'(?P<count>\d+) resolved since last review')
VERDICT_RE = re.compile(r'^###\s+(?:\S+\s+)?(?P<verdict>[A-Za-z].*?)\s*$', re.MULTILINE)
OPEN_BLOCK_RE = re.compile(r'<details open>(?P<block>.*?)</details>', re.DOTALL)
SEVERITY_RE = re.compile(r'alt="(?P<severity>High|Medium|Low) severity"')


def parse_review_body(body):
    if OVERVIEW_MARKER not in body:
        return None
    open_match = OPEN_RE.search(body)
    if open_match:
        raw = open_match.group('count')
        open_issues = 0 if raw == 'No' else int(raw)
    else:
        open_issues = 0
    resolved_match = RESOLVED_RE.search(body)
    resolved_since_last = int(resolved_match.group('count')) if resolved_match else 0
    verdict_match = VERDICT_RE.search(body)
    verdict = verdict_match.group('verdict') if verdict_match else 'Unknown'
    high = medium = low = 0
    for open_block_match in OPEN_BLOCK_RE.finditer(body):
        block = open_block_match.group('block')
        for m in SEVERITY_RE.finditer(block):
            s = m.group('severity')
            if s == 'High':
                high += 1
            elif s == 'Medium':
                medium += 1
            else:
                low += 1
    return {
        'open_issues': open_issues,
        'resolved_since_last': resolved_since_last,
        'high_severity': high,
        'medium_severity': medium,
        'low_severity': low,
        'verdict': verdict,
    }


def fetch_reviews(pr_number, repo):
    result = subprocess.run(
        ['gh', 'pr', 'view', str(pr_number), '--repo', repo, '--json', 'reviews'],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(1)
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        print('Unexpected gh output:', result.stdout, file=sys.stderr)
        sys.exit(1)
    rounds = []
    for review in data.get('reviews', []):
        if review['author']['login'] not in COPILOT_LOGINS:
            continue
        parsed = parse_review_body(review['body'])
        if parsed is None:
            continue
        rounds.append({
            'review_id': review['id'],
            'commit_sha': (review.get('commit') or {}).get('oid', ''),
            'submitted_at': review['submittedAt'],
            **parsed,
        })
    rounds.sort(key=lambda r: r['submitted_at'])
    for i, r in enumerate(rounds, 1):
        r['round'] = i
    return rounds


def log_runs(pr_number, repo, rounds):
    import mlflow
    db_path = os.path.join(os.getcwd(), 'mlflow.db')
    mlflow.set_tracking_uri('sqlite:///' + db_path)
    mlflow.set_experiment('copilot-reviews-pr-{}'.format(pr_number))
    logged = 0
    for r in rounds:
        sha7 = r['commit_sha'][:7]
        run_name = 'round-{:02d}-{}'.format(r['round'], sha7)
        with mlflow.start_run(run_name=run_name):
            mlflow.log_metrics({
                'open_issues': r['open_issues'],
                'resolved_since_last': r['resolved_since_last'],
                'high_severity': r['high_severity'],
                'medium_severity': r['medium_severity'],
                'low_severity': r['low_severity'],
                'round': r['round'],
            })
            mlflow.set_tags({
                'commit_sha': r['commit_sha'],
                'verdict': r['verdict'],
                'pr_number': str(pr_number),
                'repo': repo,
            })
        logged += 1
    return logged


def main():
    parser = argparse.ArgumentParser(description='Log Copilot review rounds to MLflow.')
    parser.add_argument('pr_number', type=int, help='Pull request number')
    parser.add_argument('--repo', default=DEFAULT_REPO, help='GitHub repo (owner/name)')
    args = parser.parse_args()
    rounds = fetch_reviews(args.pr_number, args.repo)
    if not rounds:
        print('No Copilot review rounds found for PR #{} in {}'.format(args.pr_number, args.repo))
        sys.exit(1)
    logged = log_runs(args.pr_number, args.repo, rounds)
    header = 'PR #{} ({}): {} Copilot review round(s)'.format(args.pr_number, args.repo, len(rounds))
    print(header)
    print('-' * len(header))
    fmt = '{:>5}  {:>7}  {:<25}  {:>4}  {:>8}  {:>4}  {:>6}  {:>3}'
    print(fmt.format('round', 'sha7', 'verdict', 'open', 'resolved', 'high', 'medium', 'low'))
    for r in rounds:
        print(fmt.format(
            r['round'],
            r['commit_sha'][:7],
            r['verdict'][:25],
            r['open_issues'],
            r['resolved_since_last'],
            r['high_severity'],
            r['medium_severity'],
            r['low_severity'],
        ))
    print()
    print('Logged {} run(s) to mlflow.db (experiment copilot-reviews-pr-{})'.format(logged, args.pr_number))


if __name__ == '__main__':
    main()
