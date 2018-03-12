/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

#include <libnvpair.h>
#include <stdbool.h>

#ifndef	_NVLIST_EQUAL_H
#define	_NVLIST_EQUAL_H

extern bool nvpair_equal(nvpair_t *, nvpair_t *);
extern int nvlist_equal(nvlist_t *, nvlist_t *, bool *);

#endif	/* !_NVLIST_EQUAL_H */
