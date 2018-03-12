/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * SMFX
 *
 * These routines are intended to ease the use of libscf(3LIB) by providing a
 * handle to collect details about errors that occur, and by exposing several
 * common patterns as compound operations.  The software also seeks to paper
 * over certain eccentricities and known issues with some versions of the
 * underlying implementation.
 */

#ifndef	_SMFX_H
#define	_SMFX_H

#define	SMFX_ERROR_SIZE		2048

typedef struct smfx smfx_t;

extern int smfx_alloc(smfx_t **, char *);
extern void smfx_free(smfx_t *);

extern int smfx_locate_service(smfx_t *, const char *, scf_service_t **);

extern const char *smfx_errmsg(smfx_t *);
extern scf_error_t smfx_scf_error(smfx_t *);

extern int smfx_ensure_pg(smfx_t *, scf_instance_t *, scf_propertygroup_t **,
    const char *, const char *);


extern int smfx_instance_create(smfx_t *, scf_instance_t **);
extern int smfx_ensure_instance(smfx_t *, scf_service_t *, const char *,
    scf_instance_t **);

extern int smfx_load_instance(smfx_t *, scf_service_t *, const char *,
    scf_instance_t **);

extern int smfx_load_snapshot(smfx_t *, scf_instance_t *, const char *,
    scf_snapshot_t **);

extern int smfx_instance_fmri(smfx_t *, scf_instance_t *, char **);

extern scf_handle_t *smfx_handle(smfx_t *smfx);

#endif	/* !_SMFX_H */
