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
#include <libscf.h>

#include "utils.h"
#include "nvlist_equal.h"
#include "smfx.h"

struct smfx {
	scf_handle_t *smfx_scf;
	scf_scope_t *smfx_scope;

	scf_error_t smfx_err;
	char smfx_errmsg[SMFX_ERROR_SIZE];
};

scf_handle_t *
smfx_handle(smfx_t *smfx)
{
	return (smfx->smfx_scf);
}

scf_error_t
smfx_scf_error(smfx_t *smfx)
{
	return (smfx->smfx_err);
}

const char *
smfx_errmsg(smfx_t *smfx)
{
	return (smfx->smfx_errmsg);
}

static void
make_errmsg_scf(char *errmsg, const char *func)
{
	if (errmsg == NULL) {
		return;
	}

	(void) snprintf(errmsg, SMFX_ERROR_SIZE, "%s: %s", func,
	    scf_strerror(scf_error()));
}

static void
make_errmsg_errno(char *errmsg, const char *func, int en)
{
	if (errmsg == NULL) {
		return;
	}

	const char *es = strerror(en);
	if (es == NULL) {
		(void) snprintf(errmsg, SMFX_ERROR_SIZE, "%s: errno %d",
		    func, en);
	} else {
		(void) snprintf(errmsg, SMFX_ERROR_SIZE, "%s: %s", func, es);
	}
}

static void
record_scf_error(smfx_t *smfx, const char *func)
{
	make_errmsg_scf(smfx->smfx_errmsg, func);
	smfx->smfx_err = scf_error();
}

static void
record_errno(smfx_t *smfx, const char *func)
{
	make_errmsg_errno(smfx->smfx_errmsg, func, errno);
	smfx->smfx_err = SCF_ERROR_INTERNAL;
}

static void
record_custom_error(smfx_t *smfx, const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);

	(void) vsnprintf(smfx->smfx_errmsg, SMFX_ERROR_SIZE, fmt, ap);

	va_end(ap);
}

int
smfx_alloc(smfx_t **smfxp, char *errmsg)
{
	smfx_t *smfx;

	if ((smfx = calloc(1, sizeof (*smfx))) == NULL) {
		make_errmsg_errno(errmsg, "calloc", errno);
		return (-1);
	}
	smfx->smfx_err = SCF_ERROR_NONE;

	if ((smfx->smfx_scf = scf_handle_create(SCF_VERSION)) == NULL) {
		make_errmsg_scf(errmsg, "scf_handle_create");
		free(smfx);
		return (-1);
	}

	if (scf_handle_bind(smfx->smfx_scf) != 0) {
		make_errmsg_scf(errmsg, "scf_handle_bind");
		scf_handle_destroy(smfx->smfx_scf);
		free(smfx);
		return (-1);
	}

	if ((smfx->smfx_scope = scf_scope_create(smfx->smfx_scf)) == NULL) {
		make_errmsg_scf(errmsg, "scf_scope_create");
		scf_handle_destroy(smfx->smfx_scf);
		free(smfx);
		return (-1);
	}

	if (scf_handle_get_scope(smfx->smfx_scf, SCF_SCOPE_LOCAL,
	    smfx->smfx_scope) != 0) {
		make_errmsg_scf(errmsg, "scf_handle_get_scope");
		scf_scope_destroy(smfx->smfx_scope);
		scf_handle_destroy(smfx->smfx_scf);
		free(smfx);
		return (-1);
	}

	*smfxp = smfx;
	return (0);
}

void
smfx_free(smfx_t *smfx)
{
	if (smfx == NULL) {
		return;
	}

	scf_scope_destroy(smfx->smfx_scope);
	scf_handle_destroy(smfx->smfx_scf);
	free(smfx);
}

/*
 * Create the property group with name "pgname", and type "group_type", if it
 * does not exist.  If it does exist, load it and verify that the type is as
 * specified.
 */
int
smfx_ensure_pg(smfx_t *smfx, scf_instance_t *i, scf_propertygroup_t **pgp,
    const char *pgname, const char *group_type)
{
	if (pgp != NULL) {
		*pgp = NULL;
	}

	scf_propertygroup_t *pg;
	if ((pg = scf_pg_create(smfx->smfx_scf)) == NULL) {
		record_scf_error(smfx, "scf_pg_create");
		return (-1);
	}

	/*
	 * Try to add the property group.
	 */
	if (scf_instance_add_pg(i, pgname, group_type, 0, pg) != 0) {
		if (scf_error() != SCF_ERROR_EXISTS) {
			record_scf_error(smfx, "scf_instance_add_pg");
			goto bail;
		}

		if (scf_instance_get_pg(i, pgname, pg) != 0) {
			record_scf_error(smfx, "scf_instance_get_pg");
			goto bail;
		}

		/*
		 * Check to make sure it has the correct type.
		 */
		size_t typesz = scf_limit(SCF_LIMIT_MAX_PG_TYPE_LENGTH) + 1;
		char *type;
		if ((type = malloc(typesz)) == NULL) {
			record_errno(smfx, "malloc (pg type string)");
			goto bail;
		}

		if (scf_pg_get_type(pg, type, typesz) < 0) {
			record_scf_error(smfx, "scf_pg_get_type");
			free(type);
			goto bail;
		}

		if (strcmp(type, group_type) != 0) {
			record_custom_error(smfx, "group \"%s\" has type "
			    "\"%s\", wanted \"%s\"", pgname, type, group_type);
			free(type);
			goto bail;
		}

		free(type);
	}

	if (pgp != NULL) {
		*pgp = pg;
	}
	return (0);

bail:
	scf_pg_destroy(pg);
	return (-1);
}

/*
 * When a service is initially created, before the restarter has been
 * instructed to act on the service, some of the property groups required for
 * "smf_get_state(3SCF)" to work do not yet exist.  This interface appears to
 * be brittle, if not exactly buggy, in the face of this early condition.  This
 * function pokes the restarter, if needed, to cause those property groups to
 * be created, so that subsequent calls to "smf_get_state(3SCF)" will fail only
 * for legitimate reasons such as memory exhaustion or an interrupted session.
 */
static int
flush_status(smfx_t *smfx, scf_instance_t *i)
{
	char *fmri;
	if (smfx_instance_fmri(smfx, i, &fmri) != 0) {
		return (-1);
	}

	for (;;) {
		char *st;
		if ((st = smf_get_state(fmri)) != NULL) {
			/*
			 * If we were able to get the service state, everything
			 * is fine.
			 */
			free(st);
			free(fmri);
			return (0);
		}

		if (scf_error() != SCF_ERROR_NOT_FOUND) {
			record_scf_error(smfx, "smf_get_state");
			goto bail;
		}

		/*
		 * Under some conditions a newly created service will not yet
		 * have the property which reflects whether it is enabled or
		 * disabled.  We can force the system to flush out a valid
		 * value by disabling the service.
		 */
		if (smf_refresh_instance(fmri) != 0) {
			record_scf_error(smfx, "smf_refresh_instance");
			goto bail;
		}
		if (smf_disable_instance(fmri, 0) != 0) {
			record_scf_error(smfx, "smf_disable_instance");
			goto bail;
		}

		/*
		 * Sleep for a short period and check again.
		 */
		sleep_ms(10);
		continue;

bail:
		VERIFY3P(st, ==, NULL);
		free(fmri);
		return (-1);
	}
}

int
smfx_ensure_instance(smfx_t *smfx, scf_service_t *service, const char *name,
    scf_instance_t **out)
{
	scf_instance_t *i;
	if (smfx_instance_create(smfx, &i) != 0) {
		return (-1);
	}

	if (scf_service_add_instance(service, name, i) != 0) {
		if (scf_error() != SCF_ERROR_EXISTS) {
			record_scf_error(smfx, "scf_service_add_instance");
			scf_instance_destroy(i);
			return (-1);
		}

		/*
		 * The instance exists already, so load it.
		 */
		if (scf_service_get_instance(service, name, i) != 0) {
			record_scf_error(smfx, "scf_service_get_instance");
			scf_instance_destroy(i);
			return (-1);
		}
	}

	/*
	 * Poke the restarter to ensure this service is marked as disabled and
	 * all appropriate properties get created.
	 */
	if (flush_status(smfx, i) != 0) {
		return (-1);
	}

	if (out != NULL) {
		*out = i;
	} else {
		scf_instance_destroy(i);
	}
	return (0);
}


int
smfx_locate_service(smfx_t *smfx, const char *n, scf_service_t **service)
{
	*service = NULL;

	scf_service_t *s;
	if ((s = scf_service_create(smfx->smfx_scf)) == NULL) {
		record_scf_error(smfx, "scf_service_create");
		return (-1);
	}

	if (scf_handle_decode_fmri(smfx->smfx_scf, n, smfx->smfx_scope, s, NULL,
	    NULL, NULL, SCF_DECODE_FMRI_EXACT) != 0) {
		if (scf_error() == SCF_ERROR_NOT_FOUND) {
			record_custom_error(smfx, "service \"%s\" not found",
			    n);
		} else if (scf_error() == SCF_ERROR_CONSTRAINT_VIOLATED) {
			record_custom_error(smfx, "\"%s\" is not a valid SMF "
			    "service FMRI", n);
		} else {
			record_scf_error(smfx, "scf_handle_decode_fmri");
		}

		scf_service_destroy(s);
		return (-1);
	}

	*service = s;
	return (0);
}

int
smfx_instance_fmri(smfx_t *smfx, scf_instance_t *i, char **fmri)
{
	*fmri = NULL;

	ssize_t sz;
	if ((sz = scf_instance_to_fmri(i, NULL, 0)) < 0) {
		record_scf_error(smfx, "scf_instance_to_fmri (measure)");
		return (-1);
	}

	char *t;
	if ((t = malloc(sz + 1)) == NULL) {
		record_errno(smfx, "malloc (fmri string)");
		return (-1);
	}

	if (scf_instance_to_fmri(i, t, sz + 1) < 0) {
		record_scf_error(smfx, "scf_instance_to_fmri");
		free(t);
		return (-1);
	}

	*fmri = t;
	return (0);
}

int
smfx_load_instance(smfx_t *smfx, scf_service_t *service, const char *name,
    scf_instance_t **out)
{
	scf_instance_t *i;
	if (smfx_instance_create(smfx, &i) != 0) {
		return (-1);
	}

	if (scf_service_get_instance(service, name, i) != 0) {
		record_scf_error(smfx, "scf_service_get_instance");
		scf_instance_destroy(i);
		return (-1);
	}

	*out = i;
	return (0);
}

int
smfx_load_snapshot(smfx_t *smfx, scf_instance_t *i, const char *name,
    scf_snapshot_t **snapp)
{
	scf_snapshot_t *snap;
	if ((snap = scf_snapshot_create(smfx->smfx_scf)) == NULL) {
		record_scf_error(smfx, "scf_create_snapshot");
		return (-1);
	}

	if (scf_instance_get_snapshot(i, name, snap) != 0) {
		record_scf_error(smfx, "scf_instance_get_snapshot");
		scf_snapshot_destroy(snap);
		return (-1);
	}

	*snapp = snap;
	return (0);
}

int
smfx_instance_create(smfx_t *smfx, scf_instance_t **out)
{
	*out = NULL;

	scf_instance_t *i;
	if ((i = scf_instance_create(smfx->smfx_scf)) == NULL) {
		record_scf_error(smfx, "scf_instance_create");
		return (-1);
	}

	*out = i;
	return (0);
}
