"""codigo de acceso de cada doctor

Agrega `doctors.code`: 4 digitos unicos con los que el doctor entra a su app (usuario + contrasena, sin correo). Los doctores que ya
existen reciben su codigo en el orden de su id (1001, 1002, ...); a partir de ahi lo asigna el servidor al darlos de alta.

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-12
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0007'
down_revision: Union[str, Sequence[str], None] = '0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) la columna nace opcional para poder rellenarla; 2) cada doctor recibe su codigo; 3) ya obligatoria y unica
    op.add_column('doctors', sa.Column('code', sa.String(length=4), nullable=True))
    bind = op.get_bind()
    ids = [row[0] for row in bind.execute(sa.text("SELECT id FROM doctors ORDER BY id"))]
    for n, doctor_id in enumerate(ids):
        bind.execute(sa.text("UPDATE doctors SET code = :code WHERE id = :id"), {"code": str(1001 + n), "id": doctor_id})
    with op.batch_alter_table('doctors') as batch:
        batch.alter_column('code', existing_type=sa.String(length=4), nullable=False)
        batch.create_unique_constraint(op.f('uq_doctors_code'), ['code'])


def downgrade() -> None:
    with op.batch_alter_table('doctors') as batch:
        batch.drop_constraint(op.f('uq_doctors_code'), type_='unique')
        batch.drop_column('code')
