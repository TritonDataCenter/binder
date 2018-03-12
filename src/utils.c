/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

#include <stdlib.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdbool.h>
#include <err.h>
#include <strings.h>
#include <unistd.h>
#include <errno.h>
#include <time.h>
#include <limits.h>
#include <sys/avl.h>
#include <sys/debug.h>
#include <libnvpair.h>

#include "utils.h"

void
sleep_ms(int ms)
{
	static clockid_t sleep_clock = CLOCK_HIGHRES;
	struct timespec ts;

	ts.tv_sec = ms / 1000;
	ts.tv_nsec = MSEC2NSEC(ms % 1000);

	for (;;) {
		if (clock_nanosleep(sleep_clock, 0, &ts, &ts) == 0) {
			break;
		}

		if (errno == EINTR) {
			continue;
		}

		if (errno == EPERM && sleep_clock == CLOCK_HIGHRES) {
			/*
			 * In the past, the non-adjustable clock was not
			 * universally available in zones and to non-root
			 * users.  Try again with the wall clock.
			 */
			sleep_clock = CLOCK_REALTIME;
			continue;
		}

		VERIFY3S(errno, !=, EINVAL);
		err(1, "clock_nanosleep");
	}
}

void *
safe_zalloc(size_t sz)
{
	void *ret;

	if ((ret = calloc(1, sz)) == NULL) {
		err(1, "calloc(%u)", sz);
	}

	return (ret);
}

int
parse_long(const char *input, long *output, int base)
{
	char *endp;
	long ret;

	errno = 0;
	ret = strtol(input, &endp, base);

	if (ret == 0 && errno == EINVAL) {
		return (-1);
	} else if ((ret == LONG_MAX || ret == LONG_MIN) && errno == ERANGE) {
		return (-1);
	}

	/*
	 * Any other error would appear to be a programmer error.
	 */
	VERIFY3S(errno, ==, 0);

	if (*endp != '\0') {
		/*
		 * The string contained trailing detritus after the numeric
		 * portion.
		 */
		errno = EINVAL;
		return (-1);
	}

	*output = ret;
	return (0);
}
