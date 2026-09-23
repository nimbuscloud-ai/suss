# Security

## Reporting a vulnerability

Email **matt.kindy@nimbusai.dev**. Please do not open a public issue for
a vulnerability, since anyone can read the issue tracker.

Tell us what you found, which package and version you found it in, and
how to reproduce it. A short proof of concept helps more than a long
description.

You will get a reply within a week. If we can confirm the problem, we
will agree a disclosure date with you, fix it, and credit you in the release
notes unless you would rather we did not.

## What counts

suss reads source code you give it and writes summaries of what that
code does. Two kinds of report count as a vulnerability: a way to make
suss run code from a repository it is reading, and a way to make it
write outside the directory it was pointed at.

A crash or a wrong summary is a bug. Report those in the issue
tracker, where more people can help.

## Which versions

We fix the most recent minor release. suss is pre-1.0 and has no
long-term support branches, so a fix goes out in the next release and
is not backported.
