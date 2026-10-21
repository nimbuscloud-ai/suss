import sys


def run_check(args):
    if "--fail" in args:
        return 1
    return 0


def run_init(args):
    if "--plain" in args:
        return 0
    return 2


COMMANDS = {"check": run_check, "init": run_init}


def main(argv):
    return COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
