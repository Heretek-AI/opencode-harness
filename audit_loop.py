#!/usr/bin/env python3
import argparse
import subprocess
import sys
import time

AUDIT_PROMPT = (
    "Read PROMPT_ADVERSARIAL_FLEET_AUDIT.md and execute the three-subagent "
    "adversarial audit as instructed. Write findings to AUDIT_REPORT_FINDINGS.md."
)

REMEDIATE_PROMPT = "Review and remediate findings in AUDIT_REPORT_FINDINGS.md"


def run_opencode(prompt: str, agent: str, model: str, standalone: bool) -> None:
    """Executes opencode v2 non-interactively with auto-approval."""
    cmd = [
        "opencode",
        "run",
        "--auto",
        "--agent", agent,
        "--model", model,
    ]
    if standalone:
        cmd.append("--standalone")
    cmd.append(prompt)

    print(f"\n[>>>] Executing: {' '.join(cmd)}\n" + "-" * 60)
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        print(f"\n[!] OpenCode exited with error code {e.returncode}. Halting loop.", file=sys.stderr)
        sys.exit(e.returncode)
    except KeyboardInterrupt:
        print("\n[!] Loop interrupted by user.", file=sys.stderr)
        sys.exit(130)


def main():
    parser = argparse.ArgumentParser(description="Loop OpenCode v2 audit and remediation cycles.")
    parser.add_argument(
        "-n", "--iterations",
        type=int,
        default=0,
        help="Number of cycles to run (0 for infinite loop, default: 0)"
    )
    parser.add_argument(
        "-d", "--delay",
        type=int,
        default=2,
        help="Delay in seconds between steps (default: 2)"
    )
    parser.add_argument(
        "--agent",
        default="agency-coordinator",
        help="Agent to use (default: agency-coordinator)"
    )
    parser.add_argument(
        "--model",
        default="opencode-go/muse-spark-1.3-contributor",
        help="Model to use (default: opencode-go/muse-spark-1.3-contributor)"
    )
    parser.add_argument(
        "--standalone",
        action="store_true",
        help="Run with a private server instead of the background service"
    )
    args = parser.parse_args()

    cycle = 1
    while True:
        if args.iterations > 0 and cycle > args.iterations:
            print(f"\n[+] Completed {args.iterations} cycle(s). Exiting.")
            break

        print(f"\n{'=' * 60}\n=== STARTING CYCLE {cycle} ===\n{'=' * 60}")

        # Step 1: Audit
        run_opencode(AUDIT_PROMPT, args.agent, args.model, args.standalone)
        time.sleep(args.delay)

        # Step 2: Remediate
        run_opencode(REMEDIATE_PROMPT, args.agent, args.model, args.standalone)
        time.sleep(args.delay)

        cycle += 1


if __name__ == "__main__":
    main()
