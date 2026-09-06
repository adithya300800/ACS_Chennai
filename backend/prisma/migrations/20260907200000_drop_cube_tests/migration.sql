-- Drop the standalone CubeTest feature (N5). The concrete-pour workflow
-- is now captured entirely by the cube_casting / cube_testing InspectionRecord
-- sub-types; the cube_test table is no longer referenced by any route.
DROP TABLE IF EXISTS "cube_test" CASCADE;
