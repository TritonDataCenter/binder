/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

#ifndef	_UTILS_H
#define	_UTILS_H

/*
 * It would appear that some of these definitions in "sys/time.h" have not
 * existed for as long as we would like.  For now, replicate them here if the
 * system does not provide them.
 */
#ifndef	SEC
#define	SEC				1
#endif
#ifndef	MILLISEC
#define	MILLISEC			1000
#endif
#ifndef	NANOSEC
#define	NANOSEC				1000000000LL
#endif
#ifndef	SEC2NSEC
#define	SEC2NSEC(m)			((hrtime_t)(m) * (NANOSEC / SEC))
#endif
#ifndef	MSEC2NSEC
#define	MSEC2NSEC(m)			((hrtime_t)(m) * (NANOSEC / MILLISEC))
#endif

extern void sleep_ms(int ms);
extern void *safe_zalloc(size_t sz);
extern int parse_long(const char *input, long *output, int base);

#endif	/* !_UTILS_H */
