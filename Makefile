.PHONY: check test

check:
	pre-commit run --all-files

test: check
