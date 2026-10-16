.PHONY: check test accept

check:
	bun run check
	bun test

test:
	bun test

accept:
	@if [ -z "$(WAVE)" ]; then \
		bash scripts/accept/wave-1.sh && \
		bash scripts/accept/wave-2.sh && \
		bash scripts/accept/wave-3.sh && \
		bash scripts/accept/wave-4.sh && \
		bash scripts/accept/wave-5.sh && \
		bash scripts/accept/wave-6.sh && \
		bash scripts/accept/wave-7.sh; \
	else \
		bash scripts/accept/wave-$(WAVE).sh; \
	fi
