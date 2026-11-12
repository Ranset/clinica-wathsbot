"""color elegido de cada doctor

Agrega `doctors.color` (NULL = automatico, la paleta segun su id). Es solo una columna nueva y opcional: no toca datos.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-11
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0004'
down_revision: Union[str, Sequence[str], None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('doctors', sa.Column('color', sa.String(length=7), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('doctors') as batch:
        batch.drop_column('color')
